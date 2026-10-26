import { Tags, type Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AppStack } from './app-stack.js';
import { AuthStack } from './auth-stack.js';
import { CertificateStack } from './certificate-stack.js';
import { DataStack } from './data-stack.js';
import { PROJECT, getStageConfig } from './config.js';
import { EgressIpStack } from './egress-ip-stack.js';
import { NetworkStack } from './network-stack.js';
import { WebStack } from './web-stack.js';

export interface BuildOptions {
  /** テスト用。false にすると画面ファイルを配置しない（手元のビルドの有無で結果が変わらないように） */
  readonly webBuildDir?: string | false;
}

/**
 * 全スタックを組み立てる。スタックの一覧と役割は infra/README.md を参照。
 * scope は App（自動デプロイのない環境）またはパイプラインの Stage。どちらでも同じスタック名になるよう名前を明示する。
 */
export function buildApp(
  scope: Construct,
  stageName?: string,
  account = process.env.CDK_DEFAULT_ACCOUNT,
  options: BuildOptions = {},
): Stack[] {
  const config = getStageConfig(stageName);
  const prefix = `ScheduleApp-${config.stage}`;
  // スタック自体のタグは明示する（cdk.json の explicitStackTags により Tags.of はリソースにしか付かない）
  const tags = { Project: PROJECT, Env: config.stage };
  const base = (name: string, region = config.region): StackProps & { config: typeof config } => ({
    stackName: `${prefix}-${name}`,
    env: { account, region },
    tags,
    config,
  });

  const egressIp = new EgressIpStack(scope, `${prefix}-EgressIp`, {
    ...base('EgressIp'),
    terminationProtection: true,
    description: `${PROJECT} ${config.stage}: 外部 API 向けの固定出口 IP`,
  });
  // CloudFront の証明書は us-east-1 に置く必要がある
  const certCloudFront = new CertificateStack(scope, `${prefix}-CertCloudFront`, {
    ...base('CertCloudFront', 'us-east-1'),
    purpose: 'cloudfront',
    description: `${PROJECT} ${config.stage}: CloudFront 用の証明書（${config.appDomain}）`,
  });
  const certAlb = new CertificateStack(scope, `${prefix}-CertAlb`, {
    ...base('CertAlb'),
    purpose: 'alb',
    description: `${PROJECT} ${config.stage}: ALB 用の証明書（${config.appDomain}）`,
  });
  const network = new NetworkStack(scope, `${prefix}-Network`, {
    ...base('Network'),
    eipAllocationIds: egressIp.allocationIds,
    description: `${PROJECT} ${config.stage}: VPC・サブネット・NAT・セキュリティグループ`,
  });
  const auth = new AuthStack(scope, `${prefix}-Auth`, {
    ...base('Auth'),
    description: `${PROJECT} ${config.stage}: Cognito User Pool・Web 用 App Client`,
  });
  const data = new DataStack(scope, `${prefix}-Data`, {
    ...base('Data'),
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
    terminationProtection: config.retainOnDelete,
    description: `${PROJECT} ${config.stage}: Aurora Serverless v2・Secrets Manager・ログ用 S3`,
  });
  const appStack = new AppStack(scope, `${prefix}-App`, {
    ...base('App'),
    vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup,
    appSecurityGroup: network.appSecurityGroup,
    certificate: certAlb.certificate,
    dbSecret: data.dbSecret,
    externalSecrets: data.externalSecrets,
    userPool: auth.userPool,
    webClient: auth.webClient,
    logsBucket: data.logsBucket,
    description: `${PROJECT} ${config.stage}: ECS Fargate（/api・/agent）・ALB`,
  });
  const web = new WebStack(scope, `${prefix}-Web`, {
    ...base('Web'),
    certificate: certCloudFront.certificate,
    originVerifySecret: appStack.originVerifySecret,
    webBuildDir: options.webBuildDir,
    description: `${PROJECT} ${config.stage}: S3＋CloudFront（Web 配信と /api・/agent の転送）`,
  });

  for (const [key, value] of Object.entries(tags)) Tags.of(scope).add(key, value);
  return [egressIp, certCloudFront, certAlb, network, auth, data, appStack, web];
}
