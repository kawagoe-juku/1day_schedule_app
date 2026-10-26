import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildPipeline } from '../lib/pipeline-stack.js';

const account = '123456789012';

type Action = {
  Name: string;
  ActionTypeId: { Provider: string };
  Configuration?: { StackName?: string; BranchName?: string; FullRepositoryId?: string };
};
const pipelineOf = (t: Template) =>
  (
    Object.values(t.findResources('AWS::CodePipeline::Pipeline'))[0] as {
      Properties: { PipelineType: string; Stages: { Name: string; Actions: Action[] }[] };
    }
  ).Properties;

const projects = (t: Template) =>
  Object.values(t.findResources('AWS::CodeBuild::Project')) as {
    Properties: {
      Environment: { Type: string; Image: string; ComputeType: string };
      Source: { BuildSpec: string };
    };
  }[];

describe('PipelineStack', () => {
  const app = new App();
  const stacks = buildPipeline(app, 'dev', account, { webBuildDir: false });
  const template = (stackName: string) =>
    Template.fromStack(stacks.find((s) => s.stackName === stackName)!);
  const t = template('ScheduleApp-dev-Pipeline');

  it('GitHub 接続・成果物置き場・パイプラインを作り、ci の設定がない環境には作らない', () => {
    expect(stacks.map((s) => s.stackName)).toEqual([
      'ScheduleApp-GitHubConnection',
      'ScheduleApp-dev-PipelineArtifacts',
      'ScheduleApp-dev-Pipeline',
    ]);
    expect(buildPipeline(new App(), 'prod', account)).toEqual([]);
  });

  it('V2 で、取得→ビルド→自己更新→アセット→dev へのデプロイの順', () => {
    const p = pipelineOf(t);
    expect(p.PipelineType).toBe('V2');
    expect(p.Stages.map((s) => s.Name)).toEqual([
      'Source',
      'Build',
      'UpdatePipeline',
      'Assets',
      'dev',
    ]);
    expect(p.Stages[0]!.Actions[0]!.Configuration).toMatchObject({
      FullRepositoryId: 'kawagoe-juku/1day_schedule_app',
      BranchName: 'main',
    });
  });

  it('デプロイ先のスタック名は ScheduleApp-<stage>-<名前>（手動デプロイと同じ）', () => {
    const deploy = pipelineOf(t).Stages.find((s) => s.Name === 'dev')!;
    const names = new Set(deploy.Actions.map((a) => a.Configuration?.StackName));
    expect([...names].sort()).toEqual(
      ['App', 'Auth', 'CertAlb', 'CertCloudFront', 'Data', 'EgressIp', 'Network', 'Web']
        .map((n) => `ScheduleApp-dev-${n}`)
        .sort(),
    );
  });

  it('ビルド段は ci-build.sh（テスト・画面のビルド・synth）を MEDIUM・Node 22 で実行する', () => {
    const build = projects(t).find((p) =>
      p.Properties.Source.BuildSpec.includes('scripts/ci-build.sh'),
    )!;
    expect(build.Properties.Environment).toMatchObject({
      Type: 'LINUX_CONTAINER',
      ComputeType: 'BUILD_GENERAL1_MEDIUM',
    });
    expect(build.Properties.Source.BuildSpec).toContain('"nodejs": 22');
  });

  it('サーバのイメージは ARM64 の環境でビルドする', () => {
    const docker = projects(t).filter((p) => p.Properties.Source.BuildSpec.includes('cdk-assets'));
    expect(docker.length).toBeGreaterThan(0);
    expect(docker.every((p) => p.Properties.Environment.Type === 'ARM_CONTAINER')).toBe(true);
  });

  it('失敗したときに SSM の宛先へメールで知らせる', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.codepipeline'],
        'detail-type': ['CodePipeline Pipeline Execution State Change'],
        detail: { state: ['FAILED'] },
      }),
    });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email' });
    const params = t.toJSON().Parameters as Record<string, { Default?: string }>;
    expect(Object.values(params).map((p) => p.Default)).toContain(
      '/schedule-app/dev/ops/notify-email',
    );
  });

  it('us-east-1 の成果物置き場は自前のスタックを使い、CDK の受け渡し用スタックを作らない', () => {
    // CDK の受け渡し用スタック（名前に support を含む）は CDK のデプロイ用ロールを使わず、権限を絞った CLI 用ユーザーでは作れないため
    expect(app.synth().stacks.some((s) => s.stackName.includes('support'))).toBe(false);
    expect(JSON.stringify(pipelineOf(t))).not.toContain('support');
    const policy = JSON.stringify(
      template('ScheduleApp-dev-PipelineArtifacts').findResources('AWS::S3::BucketPolicy'),
    );
    for (const role of ['deploy-role', 'cfn-exec-role']) {
      expect(policy).toContain(`cdk-hnb659fds-${role}-${account}-us-east-1`);
    }
    t.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      ArtifactStores: [
        {
          ArtifactStore: { Location: `schedule-app-dev-pipeline-${account}-us-east-1`, Type: 'S3' },
          Region: 'us-east-1',
        },
        {
          ArtifactStore: { Location: { Ref: Match.anyValue() }, Type: 'S3' },
          Region: 'ap-northeast-1',
        },
      ],
    });
  });

  it('アーティファクト用の KMS キーは作らない（同じアカウント内のみ）', () => {
    t.resourceCountIs('AWS::KMS::Key', 0);
    template('ScheduleApp-dev-PipelineArtifacts').resourceCountIs('AWS::KMS::Key', 0);
  });
});
