import { Tags, type App, type Stack } from 'aws-cdk-lib';
import { AuthStack } from './auth-stack.js';
import { CertificateStack } from './certificate-stack.js';
import { DataStack } from './data-stack.js';
import { PROJECT, getStageConfig } from './config.js';
import { EgressIpStack } from './egress-ip-stack.js';
import { NetworkStack } from './network-stack.js';

/**
 * スタック構成（WBS 2.1 で決定）。おおむね上から順に依存する（Auth はどれにも依存しない）。
 * 作成済みのものだけをここで組み立て、残りは各 WBS タスクで追加する。
 *
 * | スタック        | 内容                                              | WBS |
 * | EgressIp        | 外部 API 向けの固定出口 IP                         | 2.1 デプロイ済 |
 * | CertCloudFront  | CloudFront 用証明書（us-east-1）                   | 1.4 デプロイ済 |
 * | CertAlb         | ALB 用証明書（東京）                               | 1.4 デプロイ済 |
 * | Network         | VPC・サブネット・NAT・SG                           | 2.2 コード済（2.10 でデプロイ） |
 * | Data            | Aurora Serverless v2・Secrets Manager・ログ用 S3   | 2.3 コード済（2.10 でデプロイ） |
 * | Auth            | Cognito User Pool・App Client                      | 2.4 コード済（2.10 でデプロイ） |
 * | App             | ECR・ECS Fargate・ALB・バッチ（EventBridge）        | 2.5・7.2 |
 * | Web             | S3＋CloudFront・WAF                                | 2.6・9.2 |
 * | Pipeline        | CodePipeline／CodeBuild                            | 2.7 |
 * | Ops             | CloudWatch アラーム・ダッシュボード・Billing Alarm | 9.1 |
 */
export function buildApp(
  app: App,
  stageName?: string,
  account = process.env.CDK_DEFAULT_ACCOUNT,
): Stack[] {
  const config = getStageConfig(stageName);
  const prefix = `ScheduleApp-${config.stage}`;
  const env = { account, region: config.region };

  const egressIp = new EgressIpStack(app, `${prefix}-EgressIp`, {
    env,
    config,
    terminationProtection: true,
    description: `${PROJECT} ${config.stage}: 外部 API 向けの固定出口 IP`,
  });
  // CloudFront の証明書は us-east-1 に置く必要がある
  const certCloudFront = new CertificateStack(app, `${prefix}-CertCloudFront`, {
    env: { account, region: 'us-east-1' },
    config,
    purpose: 'cloudfront',
    description: `${PROJECT} ${config.stage}: CloudFront 用の証明書（${config.appDomain}）`,
  });
  const certAlb = new CertificateStack(app, `${prefix}-CertAlb`, {
    env,
    config,
    purpose: 'alb',
    description: `${PROJECT} ${config.stage}: ALB 用の証明書（${config.appDomain}）`,
  });
  const network = new NetworkStack(app, `${prefix}-Network`, {
    env,
    config,
    description: `${PROJECT} ${config.stage}: VPC・サブネット・NAT・セキュリティグループ`,
  });
  network.addDependency(egressIp); // 固定 IP の SSM パラメータを読むため
  const auth = new AuthStack(app, `${prefix}-Auth`, {
    env,
    config,
    description: `${PROJECT} ${config.stage}: Cognito User Pool・Web 用 App Client`,
  });

  const data = new DataStack(app, `${prefix}-Data`, {
    env,
    config,
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
    terminationProtection: config.database.deletionProtection,
    description: `${PROJECT} ${config.stage}: Aurora Serverless v2・Secrets Manager・ログ用 S3`,
  });

  const stacks: Stack[] = [egressIp, certCloudFront, certAlb, network, auth, data];

  Tags.of(app).add('Project', PROJECT);
  Tags.of(app).add('Env', config.stage);
  return stacks;
}
