import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  ParameterGroup,
} from 'aws-cdk-lib/aws-rds';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Secret, type ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { removalPolicyOf, toRetentionDays } from './common.js';
import { PROJECT, type StageConfig } from './config.js';
import { dbSecretName, externalSecretName, type ExternalSecret } from './secrets.js';

/** アプリが使う DB 名 */
export const DATABASE_NAME = 'schedule_app';
/** DB の管理ユーザー名（パスワードは Secrets Manager で自動生成） */
const DATABASE_ADMIN_USER = 'app_admin';

export interface DataStackProps extends StackProps {
  readonly config: StageConfig;
  readonly vpc: IVpc;
  readonly dbSecurityGroup: ISecurityGroup;
}

/**
 * Aurora Serverless v2（PostgreSQL）・Secrets Manager・ログ用 S3（要件定義書 4.2.2・4.2.3）。
 *
 * - データ層サブネット（外部への経路なし）に置き、接続は ECS の SG からのみ（Network で定義）。
 * - 保存時暗号化、通信は TLS 必須（rds.force_ssl）、バックアップ7日、本番は別 AZ に読み取り用を置く。
 * - DB の認証情報は自動生成して Secrets Manager に保存する。外部 API キーは登録済みのシークレットを参照するだけ。
 */
export class DataStack extends Stack {
  readonly cluster: DatabaseCluster;
  readonly dbSecret: ISecret;
  readonly externalSecrets: Record<ExternalSecret, ISecret>;
  readonly logsBucket: Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { stage, database, ops } = props.config;
    const engine = DatabaseClusterEngine.auroraPostgres({
      version: AuroraPostgresEngineVersion.VER_16_13,
    });

    const parameterGroup = new ParameterGroup(this, 'ClusterParams', {
      engine,
      description: `${PROJECT} ${stage}: TLS 必須・日本時間`,
      // 時刻の扱いをローカル開発用の DB（docker-compose）とそろえる
      parameters: { 'rds.force_ssl': '1', timezone: 'Asia/Tokyo' },
    });

    this.cluster = new DatabaseCluster(this, 'Cluster', {
      clusterIdentifier: `${PROJECT}-${stage}`,
      engine,
      parameterGroup,
      defaultDatabaseName: DATABASE_NAME,
      credentials: Credentials.fromGeneratedSecret(DATABASE_ADMIN_USER, {
        secretName: dbSecretName(stage),
      }),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.dbSecurityGroup],
      // 書き込み用は1つ目の AZ、読み取り用は2つ目以降の AZ に置く（本番の Multi-AZ を確実にするため）
      writer: ClusterInstance.serverlessV2('writer', {
        publiclyAccessible: false,
        availabilityZone: props.vpc.availabilityZones[0],
      }),
      readers: Array.from({ length: database.readers }, (_, i) =>
        ClusterInstance.serverlessV2(`reader${i + 1}`, {
          scaleWithWriter: true,
          publiclyAccessible: false,
          availabilityZone:
            props.vpc.availabilityZones[(i + 1) % props.vpc.availabilityZones.length],
        }),
      ),
      serverlessV2MinCapacity: database.minAcu,
      serverlessV2MaxCapacity: database.maxAcu,
      // 最小 0 ACU のときは、5分使われなければ自動で一時停止する（開発環境の費用を抑える）
      ...(database.minAcu === 0 ? { serverlessV2AutoPauseDuration: Duration.minutes(5) } : {}),
      storageEncrypted: true,
      // 日本時間 3:00〜4:00 にバックアップ、月曜 4:00〜5:00 にメンテナンス（いずれも UTC で指定）
      backup: {
        retention: Duration.days(database.backupRetentionDays),
        preferredWindow: '18:00-19:00',
      },
      preferredMaintenanceWindow: 'sun:19:00-sun:20:00',
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: toRetentionDays(ops.logRetentionDays),
      deletionProtection: props.config.retainOnDelete,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });
    this.dbSecret = this.cluster.secret!;

    const ref = (secret: ExternalSecret) =>
      Secret.fromSecretNameV2(this, `External-${secret}`, externalSecretName(stage, secret));
    this.externalSecrets = {
      googleMapsServer: ref('googleMapsServer'),
      googleMapsWeb: ref('googleMapsWeb'),
      navitime: ref('navitime'),
    };

    // ALB のアクセスログなどを置く（要件 4.2.3 logs-bucket：バージョニングなし、90日で削除）
    const retain = props.config.retainOnDelete;
    this.logsBucket = new Bucket(this, 'LogsBucket', {
      encryption: BucketEncryption.S3_MANAGED, // ALB のアクセスログは SSE-S3 のみ対応
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [{ id: 'expire-90-days', expiration: Duration.days(90) }],
      removalPolicy: removalPolicyOf(retain),
      autoDeleteObjects: !retain,
    });

    new CfnOutput(this, 'ClusterEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new CfnOutput(this, 'DbSecretName', { value: dbSecretName(stage) });
  }
}
