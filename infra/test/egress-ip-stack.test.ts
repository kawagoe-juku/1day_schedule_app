import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../lib/config.js';
import { EgressIpStack } from '../lib/egress-ip-stack.js';

const synth = (stage: keyof typeof STAGES) =>
  Template.fromStack(
    new EgressIpStack(new App(), `Test-${stage}`, {
      config: STAGES[stage],
      env: { account: '123456789012', region: 'ap-northeast-1' },
    }),
  );

describe('EgressIpStack', () => {
  it('dev は Elastic IP を1つ作り、削除時も保持する', () => {
    const t = synth('dev');
    t.resourceCountIs('AWS::EC2::EIP', 1);
    t.hasResource('AWS::EC2::EIP', {
      Properties: { Domain: 'vpc' },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('prod は AZ ごとに2つ作る', () => {
    synth('prod').resourceCountIs('AWS::EC2::EIP', 2);
  });

  it('割り当てIDと公開IPを SSM に保存する', () => {
    const t = synth('dev');
    t.resourceCountIs('AWS::SSM::Parameter', 2);
    const names = Object.values(t.findResources('AWS::SSM::Parameter')).map(
      (r) => (r as { Properties: { Name: string } }).Properties.Name,
    );
    expect(names.sort()).toEqual([
      '/schedule-app/dev/network/egress-ip-1/allocation-id',
      '/schedule-app/dev/network/egress-ip-1/public-ip',
    ]);
  });
});
