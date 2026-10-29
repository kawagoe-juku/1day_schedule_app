import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../lib/config.js';
import { NetworkStack } from '../lib/network-stack.js';

const build = (
  stage: keyof typeof STAGES,
  eipAllocationIds: string[] | undefined = ['eipalloc-1', 'eipalloc-2'],
) =>
  new NetworkStack(new App(), `Test-${stage}-Network`, {
    config: STAGES[stage],
    eipAllocationIds,
    cloudFrontPrefixListId: 'pl-test',
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
const synth = (stage: keyof typeof STAGES, eipAllocationIds?: string[]) =>
  Template.fromStack(build(stage, eipAllocationIds));

const subnetsByType = (t: Template) => {
  const subnets = Object.values(t.findResources('AWS::EC2::Subnet')) as {
    Properties: { Tags: { Key: string; Value: string }[]; CidrBlock: string };
  }[];
  const type = (s: (typeof subnets)[number]) =>
    s.Properties.Tags.find((tag) => tag.Key === 'aws-cdk:subnet-name')?.Value;
  return {
    public: subnets.filter((s) => type(s) === 'public'),
    app: subnets.filter((s) => type(s) === 'app'),
    data: subnets.filter((s) => type(s) === 'data'),
  };
};

describe('NetworkStack', () => {
  it('VPC は config の CIDR で、3種類のサブネットが2AZずつある', () => {
    const t = synth('dev');
    t.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: '10.100.0.0/16' });
    const s = subnetsByType(t);
    expect([s.public.length, s.app.length, s.data.length]).toEqual([2, 2, 2]);
    expect(s.app.every((x) => x.Properties.CidrBlock.endsWith('/22'))).toBe(true);
  });

  it('dev の NAT Gateway は1つで、固定 IP を使う', () => {
    const t = synth('dev');
    t.resourceCountIs('AWS::EC2::NatGateway', 1);
    t.hasResourceProperties('AWS::EC2::NatGateway', { AllocationId: 'eipalloc-1' });
    t.resourceCountIs('AWS::EC2::EIP', 0); // 新しい EIP は作らない
  });

  it('prod の NAT Gateway は2つで、固定 IP を1つずつ使う', () => {
    const t = synth('prod');
    t.resourceCountIs('AWS::EC2::NatGateway', 2);
    const ids = Object.values(t.findResources('AWS::EC2::NatGateway')).map(
      (r) => (r as { Properties: { AllocationId: string } }).Properties.AllocationId,
    );
    expect(ids.sort()).toEqual(['eipalloc-1', 'eipalloc-2']);
  });

  it('固定 IP が NAT Gateway の数より少ないとエラーにする', () => {
    expect(() => build('prod', ['eipalloc-1'])).toThrow(/固定 IP/);
  });

  it('固定 IP を指定しない場合は EgressIp の SSM パラメータから読む（Export を作らない）', () => {
    const stack = new NetworkStack(new App(), 'Test-ssm-Network', {
      config: STAGES.dev,
      cloudFrontPrefixListId: 'pl-test',
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    const params = Template.fromStack(stack).toJSON().Parameters as Record<
      string,
      { Default?: string }
    >;
    expect(Object.values(params).map((p) => p.Default)).toContain(
      '/schedule-app/dev/network/egress-ip-1/allocation-id',
    );
  });

  it('データ層のサブネットにはインターネットへの経路がない', () => {
    const t = synth('dev');
    const routes = Object.values(t.findResources('AWS::EC2::Route')) as {
      Properties: { RouteTableId: { Ref: string }; NatGatewayId?: unknown; GatewayId?: unknown };
    }[];
    const dataTables = Object.entries(t.findResources('AWS::EC2::RouteTable'))
      .filter(([logicalId]) => /data/i.test(logicalId))
      .map(([logicalId]) => logicalId);
    expect(dataTables.length).toBe(2);
    expect(routes.filter((r) => dataTables.includes(r.Properties.RouteTableId.Ref))).toEqual([]);
  });

  it('SG：ALB は 443 を CloudFront からのみ、ECS は ALB から、Aurora は ECS からのみ', () => {
    const t = synth('dev');
    const sgId = (name: string) =>
      Object.entries(t.findResources('AWS::EC2::SecurityGroup')).find(
        ([, r]) =>
          (r as { Properties: { GroupName: string } }).Properties.GroupName ===
          `schedule-app-dev-${name}`,
      )?.[0];
    const [alb, app, db] = [sgId('alb'), sgId('app'), sgId('db')];
    const ingress = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')) as {
      Properties: {
        GroupId: { 'Fn::GetAtt': [string, string] };
        FromPort: number;
        ToPort: number;
        CidrIp?: string;
        SourcePrefixListId?: string;
        SourceSecurityGroupId?: { 'Fn::GetAtt': [string, string] };
      };
    }[];
    const rules = ingress.map((r) => ({
      to: r.Properties.GroupId['Fn::GetAtt'][0],
      port: r.Properties.FromPort,
      from:
        r.Properties.SourcePrefixListId ??
        r.Properties.SourceSecurityGroupId?.['Fn::GetAtt'][0] ??
        r.Properties.CidrIp,
    }));
    expect(rules).toHaveLength(3);
    expect(rules).toContainEqual({ to: alb, port: 443, from: 'pl-test' });
    expect(rules).toContainEqual({ to: app, port: 3000, from: alb });
    expect(rules).toContainEqual({ to: db, port: 5432, from: app });
    // どの SG もインライン（SecurityGroupIngress プロパティ）で受信を許可していない
    for (const r of Object.values(t.findResources('AWS::EC2::SecurityGroup'))) {
      expect(
        (r as { Properties: Record<string, unknown> }).Properties.SecurityGroupIngress,
      ).toBeUndefined();
    }
  });

  it('SG の送信：ALB→ECS(3000)、ECS→Aurora(5432)・HTTPS(443) のみ', () => {
    const t = synth('dev');
    const sgs = t.findResources('AWS::EC2::SecurityGroup') as Record<
      string,
      {
        Properties: {
          GroupName: string;
          SecurityGroupEgress?: { CidrIp?: string; FromPort?: number }[];
        };
      }
    >;
    const idOf = (name: string) =>
      Object.entries(sgs).find(
        ([, r]) => r.Properties.GroupName === `schedule-app-dev-${name}`,
      )?.[0];
    const egress = (
      Object.values(t.findResources('AWS::EC2::SecurityGroupEgress')) as {
        Properties: {
          GroupId: { 'Fn::GetAtt': [string] };
          FromPort: number;
          DestinationSecurityGroupId: { 'Fn::GetAtt': [string] };
        };
      }[]
    ).map((r) => ({
      from: r.Properties.GroupId['Fn::GetAtt'][0],
      port: r.Properties.FromPort,
      to: r.Properties.DestinationSecurityGroupId['Fn::GetAtt'][0],
    }));
    expect(egress).toHaveLength(2);
    expect(egress).toContainEqual({ from: idOf('alb'), port: 3000, to: idOf('app') });
    expect(egress).toContainEqual({ from: idOf('app'), port: 5432, to: idOf('db') });
    const appInline = sgs[idOf('app')!]!.Properties.SecurityGroupEgress ?? [];
    expect(appInline.filter((e) => e.CidrIp === '0.0.0.0/0')).toEqual([
      expect.objectContaining({ FromPort: 443, ToPort: 443 }),
    ]);
  });

  it('S3 のゲートウェイエンドポイントがある', () => {
    const t = synth('dev');
    t.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
    const [endpoint] = Object.values(t.findResources('AWS::EC2::VPCEndpoint')) as {
      Properties: { ServiceName: unknown };
    }[];
    // リージョンが確定していれば文字列、未確定なら Fn::Join になるため、どちらでも s3 を含むことを確認する
    expect(JSON.stringify(endpoint?.Properties.ServiceName)).toMatch(/s3/);
  });
});
