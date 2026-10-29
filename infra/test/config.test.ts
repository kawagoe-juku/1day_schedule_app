import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../lib/build-app.js';
import { STAGES, getStageConfig } from '../lib/config.js';

describe('環境設定', () => {
  it.each(Object.keys(STAGES))('%s：環境名の指定だけで全スタックを組み立てられる', (stage) => {
    const app = new App({ context: { stage } });
    const stacks = buildApp(app, stage, '123456789012', { webBuildDir: false });
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

  it('ALB と CloudFront は App スタックの同じシークレットをヘッダーの値に使う', () => {
    const app = new App({ context: { stage: 'dev' } });
    const stacks = buildApp(app, 'dev', '123456789012', { webBuildDir: false });
    const json = (name: string) =>
      JSON.stringify(Template.fromStack(stacks.find((s) => s.stackName.endsWith(name))!).toJSON());
    const secretId = /"Ref":"(OriginVerifySecret[0-9A-F]+)"/.exec(json('-App'))![1]!;
    expect(json('-Web')).toContain(`ExportsOutputRef${secretId}`);
  });

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
    expect(p.database.deletionProtection).toBe(true);
    expect(p.app.minTasks).toBeGreaterThanOrEqual(2);
    expect(p.ops.logRetentionDays).toBe(90);
  });
});
