import { Tags, type App, type Stack } from 'aws-cdk-lib';
import { AppStack } from './app-stack.js';
import { AuthStack } from './auth-stack.js';
import { CertificateStack } from './certificate-stack.js';
import { DataStack } from './data-stack.js';
import { PROJECT, getStageConfig } from './config.js';
import { EgressIpStack } from './egress-ip-stack.js';
import { NetworkStack } from './network-stack.js';
import { WebStack } from './web-stack.js';

/** 全スタックを組み立てる。スタックの一覧と役割は infra/README.md を参照。 */
export function buildApp(
  app: App,
  stageName?: string,
  account = process.env.CDK_DEFAULT_ACCOUNT,
  /** テスト用。false にすると画面ファイルを配置しない（手元のビルドの有無で結果が変わらないように） */
  options: { webBuildDir?: string | false } = {},
): Stack[] {
  const config = getStageConfig(stageName);
  const prefix = `ScheduleApp-${config.stage}`;
  const env = { account, region: config.region };
  // スタック自体のタグ（推奨設定ではスタックのタグは明示が必要。リソースのタグは下の Tags.of(app) で付ける）
  const tags = { Project: PROJECT, Env: config.stage };

  const egressIp = new EgressIpStack(app, `${prefix}-EgressIp`, {
    env,
    tags,
    config,
    terminationProtection: true,
    description: `${PROJECT} ${config.stage}: 外部 API 向けの固定出口 IP`,
  });
  // CloudFront の証明書は us-east-1 に置く必要がある
  const certCloudFront = new CertificateStack(app, `${prefix}-CertCloudFront`, {
    env: { account, region: 'us-east-1' },
    tags,
    config,
    purpose: 'cloudfront',
    description: `${PROJECT} ${config.stage}: CloudFront 用の証明書（${config.appDomain}）`,
  });
  const certAlb = new CertificateStack(app, `${prefix}-CertAlb`, {
    env,
    tags,
    config,
    purpose: 'alb',
    description: `${PROJECT} ${config.stage}: ALB 用の証明書（${config.appDomain}）`,
  });
  const network = new NetworkStack(app, `${prefix}-Network`, {
    env,
    tags,
    config,
    description: `${PROJECT} ${config.stage}: VPC・サブネット・NAT・セキュリティグループ`,
  });
  network.addStackDependency(egressIp); // 固定 IP の SSM パラメータを読むため
  const auth = new AuthStack(app, `${prefix}-Auth`, {
    env,
    tags,
    config,
    description: `${PROJECT} ${config.stage}: Cognito User Pool・Web 用 App Client`,
  });

  const data = new DataStack(app, `${prefix}-Data`, {
    env,
    tags,
    config,
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
    terminationProtection: config.retainOnDelete,
    description: `${PROJECT} ${config.stage}: Aurora Serverless v2・Secrets Manager・ログ用 S3`,
  });

  const appStack = new AppStack(app, `${prefix}-App`, {
    env,
    tags,
    config,
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

  const web = new WebStack(app, `${prefix}-Web`, {
    env,
    tags,
    config,
    certificate: certCloudFront.certificate,
    originVerifySecret: appStack.originVerifySecret,
    webBuildDir: options.webBuildDir,
    description: `${PROJECT} ${config.stage}: S3＋CloudFront（Web 配信と /api・/agent の転送）`,
  });

  const stacks: Stack[] = [egressIp, certCloudFront, certAlb, network, auth, data, appStack, web];

  Tags.of(app).add('Project', PROJECT);
  Tags.of(app).add('Env', config.stage);
  return stacks;
}
