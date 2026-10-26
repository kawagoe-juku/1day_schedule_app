import { App, Tags } from 'aws-cdk-lib';
import { PROJECT, STAGES } from '../lib/config.js';
import { EgressIpStack } from '../lib/egress-ip-stack.js';

const app = new App();
const stageName = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';
const config = STAGES[stageName as keyof typeof STAGES];
if (!config) {
  throw new Error(`未知の stage です: ${stageName}（dev / stg / prod のいずれか）`);
}

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };

new EgressIpStack(app, `ScheduleApp-${config.stage}-EgressIp`, {
  env,
  config,
  terminationProtection: true,
  description: `${PROJECT} ${config.stage}: 外部 API 向けの固定出口 IP`,
});

Tags.of(app).add('Project', PROJECT);
Tags.of(app).add('Env', config.stage);
