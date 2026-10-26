import {
  Duration,
  RemovalPolicy,
  Stack,
  Stage,
  type App,
  type StackProps,
  type StageProps,
} from 'aws-cdk-lib';
import {
  BuildSpec,
  ComputeType,
  LinuxArmBuildImage,
  LinuxBuildImage,
} from 'aws-cdk-lib/aws-codebuild';
import { PipelineType } from 'aws-cdk-lib/aws-codepipeline';
import { EventField, RuleTargetInput } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import { ArnPrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { CodeBuildStep, CodePipeline, CodePipelineSource } from 'aws-cdk-lib/pipelines';
import type { Construct } from 'constructs';
import { buildApp, type BuildOptions } from './build-app.js';
import { PRIVATE_BUCKET } from './common.js';
import {
  FLUTTER_VERSION,
  GITHUB_REPO,
  PROJECT,
  getStageConfig,
  ssmPath,
  type StageConfig,
} from './config.js';
import { GitHubConnectionStack } from './github-connection-stack.js';

/** パイプラインがデプロイする環境（buildApp と同じスタックを同じ名前で組み立てる） */
class DeployStage extends Stage {
  constructor(
    scope: Construct,
    id: string,
    props: StageProps & BuildOptions & { readonly appStage: string },
  ) {
    super(scope, id, props);
    buildApp(this, props.appStage, this.account, { webBuildDir: props.webBuildDir });
  }
}

/** us-east-1 のデプロイ（CloudFront 用の証明書）でパイプラインが使う成果物置き場の名前 */
const usEast1ArtifactsBucketName = (stage: string, account: string) =>
  `${PROJECT}-${stage}-pipeline-${account}-us-east-1`;

/**
 * us-east-1 の成果物置き場。CDK が自動で作る受け渡し用スタックは CDK のデプロイ用ロールを使わず、
 * CLI 用ユーザー（docs/setup/aws-account.md。権限を絞った IAM ユーザー）では作れないため、
 * 通常のスタックとして用意してパイプラインに渡す。
 */
class PipelineArtifactsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { readonly stage: string }) {
    super(scope, id, props);
    const bucket = new Bucket(this, 'Artifacts', {
      bucketName: usEast1ArtifactsBucketName(props.stage, this.account),
      ...PRIVATE_BUCKET,
      lifecycleRules: [{ id: 'expire-30-days', expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // us-east-1 のデプロイは CDK のデプロイ用ロールが成果物を読んで行う
    for (const role of ['deploy-role', 'cfn-exec-role']) {
      bucket.grantRead(
        new ArnPrincipal(
          `arn:aws:iam::${this.account}:role/cdk-hnb659fds-${role}-${this.account}-us-east-1`,
        ),
      );
    }
  }
}

export interface PipelineStackProps extends StackProps, BuildOptions {
  readonly config: StageConfig;
  /** GitHub との接続（GitHubConnection スタック） */
  readonly connectionArn: string;
}

/**
 * 自動デプロイ（CDK Pipelines）。config.ci.branch への push で次を順に行う。
 *
 * 1. Source：GitHub から取得
 * 2. Build：テスト・lint・型チェック・API 仕様のチェック・画面のビルド・cdk synth（scripts/ci-build.sh）
 * 3. UpdatePipeline：パイプライン自身の変更を反映
 * 4. Assets：サーバのイメージ（ARM64、ECS と同じ）と画面ファイルなどを置く
 * 5. 環境へのデプロイ：全スタックを依存順に反映する
 *
 * 失敗したときはメールで知らせる（宛先は SSM パラメータ。リポジトリに書かない）。
 */
export class PipelineStack extends Stack {
  readonly pipeline: CodePipeline;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config } = props;
    const { stage } = config;
    if (!config.ci) throw new Error(`${stage} には自動デプロイの設定（ci）がありません`);

    const source = CodePipelineSource.connection(GITHUB_REPO, config.ci.branch, {
      connectionArn: props.connectionArn,
      triggerOnPush: true,
    });

    const synth = new CodeBuildStep('Build', {
      input: source,
      env: { STAGE: stage, FLUTTER_VERSION },
      commands: ['bash scripts/ci-build.sh'],
      primaryOutputDirectory: 'infra/cdk.out',
      // cdk.context.json にない検索（ホストゾーンなど）が出たときに、CDK の検索用ロールを使えるようにする
      rolePolicyStatements: [
        new PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${this.account}:role/cdk-*-lookup-role-*`],
        }),
      ],
    });

    this.pipeline = new CodePipeline(this, 'Pipeline', {
      pipelineName: `${PROJECT}-${stage}`,
      pipelineType: PipelineType.V2,
      synth,
      crossAccountKeys: false, // 同じアカウント内だけなので、費用のかかる KMS キーは作らない
      // us-east-1 の成果物置き場は PipelineArtifacts スタックのものを使う（CDK の受け渡し用スタックを作らない）
      crossRegionReplicationBuckets: {
        'us-east-1': Bucket.fromBucketAttributes(this, 'UsEast1Artifacts', {
          bucketName: usEast1ArtifactsBucketName(stage, this.account),
          region: 'us-east-1',
        }),
      },
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: LinuxBuildImage.STANDARD_7_0,
          computeType: ComputeType.SMALL,
        },
        partialBuildSpec: BuildSpec.fromObject({
          phases: { install: { 'runtime-versions': { nodejs: 22 } } },
        }),
        timeout: Duration.minutes(30),
      },
      // 画面のビルド（Flutter）にメモリを使うため、Build だけ1段大きくする
      synthCodeBuildDefaults: { buildEnvironment: { computeType: ComputeType.MEDIUM } },
      // サーバのイメージは ECS と同じ ARM64 の環境でビルドする（エミュレーションを避ける）
      assetPublishingCodeBuildDefaults: {
        buildEnvironment: {
          buildImage: LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
          computeType: ComputeType.SMALL,
          privileged: true,
        },
      },
    });

    this.pipeline.addStage(
      new DeployStage(this, stage, {
        env: { account: props.env?.account ?? this.account, region: config.region },
        appStage: stage,
        webBuildDir: props.webBuildDir,
      }),
    );
    this.pipeline.buildPipeline();

    const failures = new Topic(this, 'FailureTopic', {
      topicName: `${PROJECT}-${stage}-pipeline-failed`,
    });
    failures.addSubscription(
      new EmailSubscription(
        StringParameter.valueForStringParameter(this, ssmPath(stage, 'ops/notify-email')),
      ),
    );
    // 失敗の検知は EventBridge で行う（CodeStar Notifications はアカウントでの初回利用時に追加の設定が要るため使わない）
    this.pipeline.pipeline.onStateChange('Failed', {
      eventPattern: { detail: { state: ['FAILED'] } },
      target: new SnsTopic(failures, {
        message: RuleTargetInput.fromText(
          `[${PROJECT} ${stage}] 自動デプロイが失敗しました。パイプライン ${EventField.fromPath('$.detail.pipeline')}、実行 ID ${EventField.fromPath('$.detail.execution-id')}。CodePipeline のコンソールで失敗した段のログを確認してください。`,
        ),
      }),
    });
  }
}

/**
 * 自動デプロイ（CodePipeline）のスタックを組み立てる。config.ci がない環境では何も作らない。
 * GitHub 接続は環境に共通なので1つだけ作る。
 */
export function buildPipeline(
  app: App,
  stageName?: string,
  account = process.env.CDK_DEFAULT_ACCOUNT,
  options: BuildOptions = {},
): Stack[] {
  const config = getStageConfig(stageName);
  if (!config.ci) return [];
  const prefix = `ScheduleApp-${config.stage}`;
  const env = { account, region: config.region };
  const tags = { Project: PROJECT, Env: config.stage };

  const connection = new GitHubConnectionStack(app, 'ScheduleApp-GitHubConnection', {
    stackName: 'ScheduleApp-GitHubConnection',
    env,
    tags: { Project: PROJECT },
    description: `${PROJECT}: GitHub との接続（CodeConnections）`,
  });
  const artifacts = new PipelineArtifactsStack(app, `${prefix}-PipelineArtifacts`, {
    stackName: `${prefix}-PipelineArtifacts`,
    env: { account, region: 'us-east-1' },
    tags,
    stage: config.stage,
    description: `${PROJECT} ${config.stage}: 自動デプロイの成果物置き場（us-east-1）`,
  });
  const pipeline = new PipelineStack(app, `${prefix}-Pipeline`, {
    stackName: `${prefix}-Pipeline`,
    env,
    tags,
    config,
    connectionArn: connection.connectionArn,
    webBuildDir: options.webBuildDir,
    description: `${PROJECT} ${config.stage}: 自動デプロイ（CodePipeline／CodeBuild）`,
  });
  pipeline.addStackDependency(artifacts); // 成果物置き場を先に作る
  return [connection, artifacts, pipeline];
}
