import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/build-app.js';
import { getStageConfig } from '../lib/config.js';
import { buildPipeline } from '../lib/pipeline-stack.js';

const app = new App();
const stage = app.node.tryGetContext('stage') as string | undefined;
// 自動デプロイのある環境は、パイプラインの中（ScheduleApp-<stage>-Pipeline/<stage>/…）にだけスタックを置く。
// 外にも置くと構成のパス（論理 ID に入る）が違う同名スタックができ、手動とパイプラインで中身が食い違うため。
if (!getStageConfig(stage).ci) buildApp(app, stage);
buildPipeline(app, stage);
