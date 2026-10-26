import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../lib/build-app.js';
import { toRetentionDays } from '../lib/common.js';
import { STAGES, getStageConfig } from '../lib/config.js';
import { externalSecretName } from '../lib/secrets.js';

const build = (stage: string) => {
  const app = new App();
  return { app, stacks: buildApp(app, stage, '123456789012', { webBuildDir: false }) };
};

describe('環境設定', () => {
  it('未知の環境名はエラーにする', () => {
    expect(() => getStageConfig('test')).toThrow(/未知の stage/);
  });

  it('VPC のアドレス範囲が環境間で重ならない', () => {
    const cidrs = Object.values(STAGES).map((c) => c.network.vpcCidr);
    expect(new Set(cidrs).size).toBe(cidrs.length);
  });

  it.each(Object.values(STAGES))('$stage：設定値の範囲が正しい', (c) => {
    expect(c.network.azCount).toBeGreaterThanOrEqual(2);
    expect(c.network.natGateways).toBeLessThanOrEqual(c.network.azCount);
    expect(c.app.minTasks).toBeLessThanOrEqual(c.app.maxTasks);
    expect(c.database.minAcu).toBeLessThanOrEqual(c.database.maxAcu);
    expect(c.database.backupRetentionDays).toBe(7);
  });

  it('本番は Multi-AZ・削除保護・ログ90日', () => {
    const p = STAGES.prod;
    expect(p.network.natGateways).toBe(2);
    expect(p.database.readers).toBeGreaterThanOrEqual(1);
    expect(p.retainOnDelete).toBe(true);
    expect(p.app.ecsExec).toBe(false);
    expect(p.app.minTasks).toBeGreaterThanOrEqual(2);
    expect(p.ops.logRetentionDays).toBe(90);
  });

  it('外部 API キーのシークレット名：dev は環境名なし、stg・prod は環境名付き', () => {
    expect(externalSecretName('dev', 'navitime')).toBe('ai-schedule-app/navitime-rapidapi-key');
    expect(externalSecretName('prod', 'googleMapsServer')).toBe(
      'ai-schedule-app/prod/google-maps-api-key',
    );
  });

  it('ログ保持日数は 30・90 日のみ対応', () => {
    expect(() => toRetentionDays(45)).toThrow(/未対応/);
  });
});

describe('全スタックの組み立て（buildApp）', () => {
  it.each(Object.keys(STAGES))('%s：環境名の指定だけで全スタックを組み立てられる', (stage) => {
    const { app, stacks } = build(stage);
    expect(stacks.map((s) => s.stackName)).toEqual([
      `ScheduleApp-${stage}-EgressIp`,
      `ScheduleApp-${stage}-CertCloudFront`,
      `ScheduleApp-${stage}-CertAlb`,
      `ScheduleApp-${stage}-Network`,
      `ScheduleApp-${stage}-Auth`,
      `ScheduleApp-${stage}-Data`,
      `ScheduleApp-${stage}-App`,
      `ScheduleApp-${stage}-Web`,
    ]);
    expect(() => app.synth()).not.toThrow();
  });

  const dev = build('dev');
  const template = (suffix: string) =>
    Template.fromStack(dev.stacks.find((s) => s.stackName.endsWith(suffix))!);

  it('ALB と CloudFront は App スタックの同じシークレットをヘッダーの値に使う', () => {
    const app = JSON.stringify(template('-App').toJSON());
    const secretId = /"Ref":"(OriginVerifySecret[0-9A-F]+)"/.exec(app)![1]!;
    expect(JSON.stringify(template('-Web').toJSON())).toContain(`OutputRef${secretId}`);
  });

  it('NAT Gateway は EgressIp の固定 IP を出力値の参照で使い、SSM パラメータは読まない', () => {
    // CDK のデプロイ用ロールは /schedule-app/* の SSM パラメータを読めないため、参照で受け渡す
    const network = template('-Network');
    const nat = JSON.stringify(network.findResources('AWS::EC2::NatGateway'));
    expect(nat).toContain('ScheduleApp-dev-EgressIp');
    const params = Object.values(network.toJSON().Parameters ?? {}) as { Type: string }[];
    expect(params.filter((p) => p.Type.startsWith('AWS::SSM::Parameter::Value'))).toHaveLength(1); // BootstrapVersion のみ
  });

  it('サーバのイメージのビルドに Dockerfile が含まれる（.dockerignore で除外しない）', () => {
    const asm = dev.app.synth();
    const manifest = JSON.parse(
      readFileSync(join(asm.directory, 'ScheduleApp-dev-App.assets.json'), 'utf8'),
    ) as { dockerImages: Record<string, { source: { directory: string; dockerFile: string } }> };
    const images = Object.values(manifest.dockerImages);
    expect(images).toHaveLength(1);
    const { directory, dockerFile } = images[0]!.source;
    expect(existsSync(join(asm.directory, directory, dockerFile))).toBe(true);
  });

  it('RDS・EC2・Secrets Manager・ELB・CloudFront の設定値は ASCII のみ（日本語は作成時にエラーになるため）', () => {
    const strict = /^AWS::(RDS|EC2|SecretsManager|ElasticLoadBalancingV2|CloudFront)::/;
    const offending = dev.stacks.flatMap((stack) =>
      Object.entries(
        Template.fromStack(stack).toJSON().Resources as Record<
          string,
          { Type: string; Properties?: Record<string, unknown> }
        >,
      )
        .filter(([, r]) => strict.test(r.Type))
        // 説明・コメント・固定応答の本文など、すべての項目を対象にする
        .filter(([, r]) => /[^\x20-\x7E]/.test(JSON.stringify(r.Properties ?? {})))
        .map(([id]) => `${stack.stackName}/${id}`),
    );
    expect(offending).toEqual([]);
  });
});
