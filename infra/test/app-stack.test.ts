import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContainerImage } from 'aws-cdk-lib/aws-ecs';
import { describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack.js';
import { AuthStack } from '../lib/auth-stack.js';
import { CertificateStack } from '../lib/certificate-stack.js';
import { STAGES } from '../lib/config.js';
import { DataStack } from '../lib/data-stack.js';
import { NetworkStack } from '../lib/network-stack.js';

const env = { account: '123456789012', region: 'ap-northeast-1' };

const synth = (stage: keyof typeof STAGES) => {
  const app = new App();
  const config = STAGES[stage];
  const network = new NetworkStack(app, `T-${stage}-Network`, {
    config,
    eipAllocationIds: ['eipalloc-1', 'eipalloc-2'],
    cloudFrontPrefixListId: 'pl-test',
    env,
  });
  const data = new DataStack(app, `T-${stage}-Data`, {
    config,
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
    env,
  });
  const auth = new AuthStack(app, `T-${stage}-Auth`, { config, env });
  const cert = new CertificateStack(app, `T-${stage}-CertAlb`, {
    config,
    purpose: 'alb',
    hostedZoneId: 'Z0000000000000000000',
    env,
  });
  const stack = new AppStack(app, `T-${stage}-App`, {
    config,
    vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup,
    appSecurityGroup: network.appSecurityGroup,
    certificate: cert.certificate,
    dbSecret: data.dbSecret,
    databaseName: 'schedule_app',
    databasePort: data.cluster.clusterEndpoint.port.toString(),
    externalSecrets: data.externalSecrets,
    userPool: auth.userPool,
    webClient: auth.webClient,
    logsBucket: data.logsBucket,
    image: ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:22-slim'),
    hostedZoneId: 'Z0000000000000000000',
    env,
  });
  return { t: Template.fromStack(stack), data: Template.fromStack(data) };
};

describe('AppStack', () => {
  it('タスクは ARM64・0.25 vCPU・0.5 GB', () => {
    synth('dev').t.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256',
      Memory: '512',
      RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      RequiresCompatibilities: ['FARGATE'],
    });
  });

  it('コンテナは 3000 番で待ち受け、DB と外部 API キーは Secrets Manager から注入する', () => {
    const { t } = synth('dev');
    const td = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0] as {
      Properties: {
        ContainerDefinitions: {
          PortMappings: { ContainerPort: number }[];
          Environment: { Name: string; Value: unknown }[];
          Secrets: { Name: string }[];
        }[];
      };
    };
    const c = td.Properties.ContainerDefinitions[0]!;
    expect(c.PortMappings[0]!.ContainerPort).toBe(3000);
    expect(c.Secrets.map((s) => s.Name).sort()).toEqual([
      'DB_HOST',
      'DB_PASSWORD',
      'DB_USER',
      'GOOGLE_MAPS_SERVER_KEY',
      'NAVITIME_RAPIDAPI_KEY',
    ]);
    const envNames = c.Environment.map((e) => e.Name);
    expect(envNames).toEqual(
      expect.arrayContaining([
        'NODE_ENV',
        'PORT',
        'COGNITO_USER_POOL_ID',
        'COGNITO_WEB_CLIENT_ID',
        'BEDROCK_MODEL_ID',
      ]),
    );
    // パスワードなどの値を環境変数に直接書いていない
    expect(envNames.some((n) => /PASSWORD|KEY$/.test(n))).toBe(false);
  });

  it('タスクロールは Bedrock（jp. の Claude）と ECS Exec 用（通信・セッションログ）だけ', () => {
    const { t } = synth('dev');
    const taskDef = Object.values(t.findResources('AWS::ECS::TaskDefinition'))[0] as {
      Properties: { TaskRoleArn: { 'Fn::GetAtt': [string, string] } };
    };
    const taskRoleId = taskDef.Properties.TaskRoleArn['Fn::GetAtt'][0];
    const policies = Object.values(t.findResources('AWS::IAM::Policy')) as {
      Properties: {
        Roles: { Ref: string }[];
        PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] };
      };
    }[];
    const statements = policies
      .filter((p) => p.Properties.Roles.some((r) => r.Ref === taskRoleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    // ECS Exec を有効にすると、CDK が通信（ssmmessages）とセッションログ（logs）の権限を付ける
    expect(actions.every((a) => /^(bedrock|ssmmessages|logs):/.test(a))).toBe(true);
    const bedrock = statements.find((s) => JSON.stringify(s.Action).includes('bedrock'))!;
    expect(bedrock.Action).toEqual([
      'bedrock:InvokeModel',
      'bedrock:InvokeModelWithResponseStream',
    ]);
    const resources = JSON.stringify(bedrock.Resource);
    expect(resources).toContain('inference-profile/jp.anthropic.*');
    expect(resources).toContain('arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.*');
    expect(resources).toContain('arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.*');
    expect(resources).not.toMatch(/bedrock:\*:|inference-profile\/\*"/); // 全リージョン・全プロファイルを許可していない
  });

  it('実行ロールは注入するシークレットを読める', () => {
    const { t } = synth('dev');
    const json = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(json).toContain('secretsmanager:GetSecretValue');
  });

  it('dev のサーバのロググループは30日保持で、作り直せるよう削除可能', () => {
    synth('dev').t.hasResource('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: '/schedule-app/dev/server', RetentionInDays: 30 },
      DeletionPolicy: 'Delete',
    });
  });

  it('サービスはアプリ層サブネット・公開 IP なし・失敗時は自動で戻す・ECS Exec 有効', () => {
    synth('dev').t.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      EnableExecuteCommand: true,
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
      }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }),
      },
    });
  });

  it('台数は config の範囲で CPU 60% を目安に増減する', () => {
    const { t } = synth('prod');
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 2,
      MaxCapacity: 4,
    });
    t.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({ TargetValue: 60 }),
    });
  });

  it('ALB はインターネット向け・HTTPS 443 のみ（TLS 1.2 以上）・アクセスログあり', () => {
    const { t } = synth('dev');
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      DefaultActions: [Match.objectLike({ Type: 'fixed-response' })],
    });
    const lb = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'))[0] as {
      Properties: { Scheme: string; LoadBalancerAttributes: { Key: string; Value: unknown }[] };
    };
    expect(lb.Properties.Scheme).toBe('internet-facing');
    const attrs = Object.fromEntries(
      lb.Properties.LoadBalancerAttributes.map((a) => [a.Key, a.Value]),
    );
    expect(attrs['access_logs.s3.enabled']).toBe('true');
    expect(attrs['access_logs.s3.prefix']).toBe('alb');
    expect(attrs['idle_timeout.timeout_seconds']).toBe('60');
    expect(attrs['routing.http.drop_invalid_header_fields.enabled']).toBe('true');
  });

  it('/api/* と /agent/* をサーバへ振り分け、ヘルスチェックは /api/health', () => {
    const { t } = synth('dev');
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/api/*', '/agent/*'] } },
      ],
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 3000,
      Protocol: 'HTTP',
      TargetType: 'ip',
      HealthCheckPath: '/api/health',
      Matcher: { HttpCode: '200' },
    });
  });

  it('SG のルールを App スタックで追加しない（Network の定義だけを使う）', () => {
    const { t } = synth('dev');
    t.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    t.resourceCountIs('AWS::EC2::SecurityGroupEgress', 0);
    t.resourceCountIs('AWS::EC2::SecurityGroup', 0);
  });

  it('origin.<appDomain> を ALB に向ける', () => {
    synth('dev').t.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'origin.dev.super-ai-schedule-app.com.',
      Type: 'A',
    });
  });

  it('本番の ALB は削除保護あり', () => {
    synth('prod').t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'deletion_protection.enabled', Value: 'true' },
      ]),
    });
  });
});
