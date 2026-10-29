import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import type { IUserPool, IUserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { SecurityGroup, SubnetType, type ISecurityGroup, type IVpc } from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationListener,
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
  SslPolicy,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ARecord, HostedZone, RecordTarget, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, ROOT_DOMAIN, type StageConfig } from './config.js';
import { toRetentionDays } from './data-stack.js';
import { APP_PORT } from './network-stack.js';
import { EXTERNAL_SECRETS, type ExternalSecret } from './secrets.js';

/** ALB のヘルスチェック先（DB に触れないエンドポイント） */
export const HEALTH_CHECK_PATH = '/api/health';
/** CloudFront から ALB へ接続するときのドメイン名（ALB 用証明書の *.<appDomain> に含まれる） */
export const originDomain = (appDomain: string): string => `origin.${appDomain}`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface AppStackProps extends StackProps {
  readonly config: StageConfig;
  readonly vpc: IVpc;
  readonly albSecurityGroup: ISecurityGroup;
  readonly appSecurityGroup: ISecurityGroup;
  readonly certificate: ICertificate;
  readonly dbSecret: ISecret;
  /** DB 名（Data スタックの DATABASE_NAME） */
  readonly databaseName: string;
  /** DB のポート（クラスタのエンドポイントから） */
  readonly databasePort: string;
  readonly externalSecrets: Record<ExternalSecret, ISecret>;
  readonly userPool: IUserPool;
  readonly webClient: IUserPoolClient;
  readonly logsBucket: IBucket;
  /** テスト用。指定しない場合は server/Dockerfile からイメージをビルドする */
  readonly image?: ContainerImage;
  /** テスト用。指定しない場合は Route 53 からホストゾーンを検索する */
  readonly hostedZoneId?: string;
}

/**
 * WBS 2.5：ECR（CDK アセット）・ECS Fargate・ALB（要件定義書 4.1.1・4.2.1）。
 *
 * - サーバは単一のコンテナで /api/* と /agent/* を受ける。ALB は HTTPS 443 のみ・CloudFront 経由のみ。
 * - SG は Network のものを変更不可として読み込み、CDK が自動でルールを足さないようにする（重複・全開放の防止）。
 * - 初回（2.10）は Mac の Docker で server/Dockerfile をビルドして ECR に置く。2.7 で自動デプロイに切り替える。
 * - DB の接続情報と外部 API キーは Secrets Manager から環境変数として注入する（イメージや設定に値を含めない）。
 * - タスクの権限は Bedrock（Claude）の呼び出しと、ECS Exec 用（ssmmessages・logs）のみ。
 */
export class AppStack extends Stack {
  readonly loadBalancer: ApplicationLoadBalancer;
  readonly originDomainName: string;
  readonly service: FargateService;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { stage, app, ops, appDomain, database } = props.config;
    const name = `${PROJECT}-${stage}`;

    // Network で定義済みのルールだけを使う（mutable: false で CDK による追加を防ぐ）
    const albSg = SecurityGroup.fromSecurityGroupId(
      this,
      'AlbSg',
      props.albSecurityGroup.securityGroupId,
      {
        mutable: false,
      },
    );
    const appSg = SecurityGroup.fromSecurityGroupId(
      this,
      'AppSg',
      props.appSecurityGroup.securityGroupId,
      {
        mutable: false,
      },
    );

    const cluster = new Cluster(this, 'Cluster', { clusterName: name, vpc: props.vpc });

    const taskDefinition = new FargateTaskDefinition(this, 'TaskDef', {
      family: `${name}-server`,
      cpu: app.cpu,
      memoryLimitMiB: app.memoryMiB,
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
        operatingSystemFamily: OperatingSystemFamily.LINUX,
      },
    });

    const logGroup = new LogGroup(this, 'ServerLogs', {
      logGroupName: `/${PROJECT}/${stage}/server`,
      retention: toRetentionDays(ops.logRetentionDays),
      // dev は作り直しやすいよう削除する（初回作成の失敗でロググループだけが残るのを防ぐ）
      removalPolicy: database.deletionProtection ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const image =
      props.image ??
      ContainerImage.fromAsset(REPO_ROOT, {
        file: 'server/Dockerfile',
        platform: Platform.LINUX_ARM64,
      });

    const external = (secret: ExternalSecret) =>
      EcsSecret.fromSecretsManager(props.externalSecrets[secret], EXTERNAL_SECRETS[secret].key);

    taskDefinition.addContainer('server', {
      containerName: 'server',
      image,
      portMappings: [{ containerPort: APP_PORT }],
      logging: LogDrivers.awsLogs({ logGroup, streamPrefix: 'server' }),
      environment: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: String(APP_PORT),
        LOG_LEVEL: 'info',
        APP_STAGE: stage,
        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_WEB_CLIENT_ID: props.webClient.userPoolClientId,
        BEDROCK_MODEL_ID: app.bedrockModelId,
        // DB 名とポートは秘密ではないので通常の環境変数で渡す（ホスト・ユーザー・パスワードはシークレットから）
        DB_NAME: props.databaseName,
        DB_PORT: props.databasePort,
      },
      secrets: {
        DB_HOST: EcsSecret.fromSecretsManager(props.dbSecret, 'host'),
        DB_USER: EcsSecret.fromSecretsManager(props.dbSecret, 'username'),
        DB_PASSWORD: EcsSecret.fromSecretsManager(props.dbSecret, 'password'),
        GOOGLE_MAPS_SERVER_KEY: external('googleMapsServer'),
        NAVITIME_RAPIDAPI_KEY: external('navitime'),
      },
    });

    // Bedrock：国内処理（jp.）の推論プロファイル経由で Claude だけを呼べる（2026-10-26 決定）。
    // jp. の推論プロファイルは東京・大阪のどちらかで処理するため、モデルは両リージョンを許可する。
    taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/jp.anthropic.*`,
          'arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.*',
          'arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.*',
        ],
      }),
    );

    this.service = new FargateService(this, 'Service', {
      serviceName: `${name}-server`,
      cluster,
      taskDefinition,
      desiredCount: app.minTasks,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [appSg],
      assignPublicIp: false,
      circuitBreaker: { rollback: true }, // 起動に失敗した版は自動で元に戻す
      enableExecuteCommand: true, // 調査用（使うときは CLI 用ユーザーに権限を追加する）
      healthCheckGracePeriod: Duration.seconds(30),
    });
    this.service
      .autoScaleTaskCount({ minCapacity: app.minTasks, maxCapacity: app.maxTasks })
      .scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });

    this.loadBalancer = new ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: name,
      vpc: props.vpc,
      internetFacing: true, // CloudFront からの接続用。SG で CloudFront 以外を拒否する
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroup: albSg,
      idleTimeout: Duration.seconds(60), // 計画生成のサーバ打ち切り（13秒）より長くする
      dropInvalidHeaderFields: true,
      deletionProtection: database.deletionProtection,
    });
    this.loadBalancer.logAccessLogs(props.logsBucket, 'alb');

    const targetGroup = new ApplicationTargetGroup(this, 'ServerTargets', {
      targetGroupName: `${name}-server`,
      vpc: props.vpc,
      port: APP_PORT,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targets: [this.service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        path: HEALTH_CHECK_PATH,
        healthyHttpCodes: '200',
        interval: Duration.seconds(30),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    const listener = new ApplicationListener(this, 'Https', {
      loadBalancer: this.loadBalancer,
      port: 443,
      protocol: ApplicationProtocol.HTTPS,
      certificates: [props.certificate],
      sslPolicy: SslPolicy.RECOMMENDED_TLS, // TLS 1.2 以上
      open: false, // 0.0.0.0/0 の許可を自動で足さない（CloudFront のみ許可は Network の SG で行う）
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: 'application/json',
        messageBody: JSON.stringify({
          error: { code: 'NOT_FOUND', message: '対象が見つかりません' },
        }),
      }),
    });
    // 2.6 で、CloudFront だけが付ける秘密のヘッダーも条件に加える（他人の CloudFront からの接続を防ぐ）
    listener.addAction('ApiAndAgent', {
      priority: 10,
      conditions: [ListenerCondition.pathPatterns(['/api/*', '/agent/*'])],
      action: ListenerAction.forward([targetGroup]),
    });

    const zone: IHostedZone = props.hostedZoneId
      ? HostedZone.fromHostedZoneAttributes(this, 'Zone', {
          hostedZoneId: props.hostedZoneId,
          zoneName: ROOT_DOMAIN,
        })
      : HostedZone.fromLookup(this, 'Zone', { domainName: ROOT_DOMAIN });
    this.originDomainName = originDomain(appDomain);
    new ARecord(this, 'OriginRecord', {
      zone,
      recordName: this.originDomainName,
      target: RecordTarget.fromAlias(new LoadBalancerTarget(this.loadBalancer)),
    });

    new CfnOutput(this, 'OriginDomain', { value: this.originDomainName });
  }
}
