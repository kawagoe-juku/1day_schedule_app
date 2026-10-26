import { Tags, type App, type Stack } from 'aws-cdk-lib';
import { CertificateStack } from './certificate-stack.js';
import { PROJECT, getStageConfig } from './config.js';
import { EgressIpStack } from './egress-ip-stack.js';

/**
 * スタック構成（WBS 2.1 で決定）。上から順に依存する。
 * 作成済みのものだけをここで組み立て、残りは各 WBS タスクで追加する。
 *
 * | スタック        | 内容                                              | WBS |
 * | EgressIp        | 外部 API 向けの固定出口 IP                         | 2.1 済 |
 * | CertCloudFront  | CloudFront 用証明書（us-east-1）                   | 1.4 済 |
 * | CertAlb         | ALB 用証明書（東京）                               | 1.4 済 |
 * | Network         | VPC・サブネット・NAT・SG                           | 2.2 |
 * | Data            | Aurora Serverless v2・Secrets Manager              | 2.3 |
 * | Auth            | Cognito User Pool・App Client                      | 2.4 |
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

  const stacks: Stack[] = [
    new EgressIpStack(app, `${prefix}-EgressIp`, {
      env,
      config,
      terminationProtection: true,
      description: `${PROJECT} ${config.stage}: 外部 API 向けの固定出口 IP`,
    }),
    // CloudFront の証明書は us-east-1 に置く必要がある
    new CertificateStack(app, `${prefix}-CertCloudFront`, {
      env: { account, region: 'us-east-1' },
      config,
      purpose: 'cloudfront',
      description: `${PROJECT} ${config.stage}: CloudFront 用の証明書（${config.appDomain}）`,
    }),
    new CertificateStack(app, `${prefix}-CertAlb`, {
      env,
      config,
      purpose: 'alb',
      description: `${PROJECT} ${config.stage}: ALB 用の証明書（${config.appDomain}）`,
    }),
  ];

  Tags.of(app).add('Project', PROJECT);
  Tags.of(app).add('Env', config.stage);
  return stacks;
}
