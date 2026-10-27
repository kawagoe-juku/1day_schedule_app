import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../lib/config.js';
import { DataStack, toRetentionDays } from '../lib/data-stack.js';
import { NetworkStack } from '../lib/network-stack.js';
import { externalSecretName } from '../lib/secrets.js';

const env = { account: '123456789012', region: 'ap-northeast-1' };

const synth = (stage: keyof typeof STAGES) => {
  const app = new App();
  const network = new NetworkStack(app, `Test-${stage}-Network`, {
    config: STAGES[stage],
    eipAllocationIds: ['eipalloc-1', 'eipalloc-2'],
    cloudFrontPrefixListId: 'pl-test',
    env,
  });
  const data = new DataStack(app, `Test-${stage}-Data`, {
    config: STAGES[stage],
    vpc: network.vpc,
    dbSecurityGroup: network.dbSecurityGroup,
    env,
  });
  return Template.fromStack(data);
};

describe('DataStack', () => {
  it('Aurora PostgreSQL 16（Serverless v2）を暗号化・バックアップ7日で作る', () => {
    synth('dev').hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: Match.stringLikeRegexp('^16\\.'),
      DatabaseName: 'schedule_app',
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
      PreferredBackupWindow: '18:00-19:00',
      EnableCloudwatchLogsExports: ['postgresql'],
    });
  });

  it('dev は 0〜2 ACU で自動停止あり、読み取り用なし、削除保護なし', () => {
    const t = synth('dev');
    t.hasResourceProperties('AWS::RDS::DBCluster', {
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0,
        MaxCapacity: 2,
        SecondsUntilAutoPause: 300,
      },
      DeletionProtection: false,
    });
    t.resourceCountIs('AWS::RDS::DBInstance', 1);
  });

  it('prod は 0.5〜4 ACU、別 AZ に読み取り用1台、削除保護あり', () => {
    const t = synth('prod');
    const cluster = Object.values(t.findResources('AWS::RDS::DBCluster'))[0] as {
      Properties: {
        ServerlessV2ScalingConfiguration: Record<string, number>;
        DeletionProtection: boolean;
      };
    };
    expect(cluster.Properties.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0.5,
      MaxCapacity: 4,
    });
    expect(cluster.Properties.DeletionProtection).toBe(true);
    t.resourceCountIs('AWS::RDS::DBInstance', 2);
  });

  it('スタックを削除してもスナップショットを残す', () => {
    synth('dev').hasResource('AWS::RDS::DBCluster', {
      DeletionPolicy: 'Snapshot',
      UpdateReplacePolicy: 'Snapshot',
    });
  });

  it('通信は TLS 必須', () => {
    synth('dev').hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Parameters: { 'rds.force_ssl': '1' },
    });
  });

  it('インスタンスは公開せず、本番の書き込み用と読み取り用は別の AZ に置く', () => {
    const instances = Object.values(synth('prod').findResources('AWS::RDS::DBInstance')) as {
      Properties: { PubliclyAccessible?: boolean; AvailabilityZone?: string };
    }[];
    expect(instances).toHaveLength(2);
    expect(instances.every((i) => i.Properties.PubliclyAccessible === false)).toBe(true);
    const azs = instances.map((i) => i.Properties.AvailabilityZone);
    expect(azs.sort()).toEqual(['ap-northeast-1a', 'ap-northeast-1c']);
  });

  it('stg は 0.5〜2 ACU で自動停止なし、削除保護あり', () => {
    const cluster = Object.values(synth('stg').findResources('AWS::RDS::DBCluster'))[0] as {
      Properties: {
        ServerlessV2ScalingConfiguration: Record<string, number>;
        DeletionProtection: boolean;
      };
    };
    expect(cluster.Properties.ServerlessV2ScalingConfiguration).toEqual({
      MinCapacity: 0.5,
      MaxCapacity: 2,
    });
    expect(cluster.Properties.DeletionProtection).toBe(true);
  });

  it('DB はデータ層サブネットに置き、Network の DB 用 SG を使う', () => {
    const t = synth('dev');
    const group = Object.values(t.findResources('AWS::RDS::DBSubnetGroup'))[0] as {
      Properties: { SubnetIds: { 'Fn::ImportValue': string }[] };
    };
    expect(group.Properties.SubnetIds).toHaveLength(2);
    expect(JSON.stringify(group.Properties.SubnetIds)).toMatch(/data/i);
    const cluster = Object.values(t.findResources('AWS::RDS::DBCluster'))[0] as {
      Properties: { VpcSecurityGroupIds: unknown };
    };
    expect(JSON.stringify(cluster.Properties.VpcSecurityGroupIds)).toMatch(/DbSg/);
  });

  it('DB の認証情報を自動生成し、決まった名前で Secrets Manager に保存する', () => {
    synth('dev').hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'ai-schedule-app/dev/db',
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: '{"username":"app_admin"}' }),
    });
  });

  it('ログ用 S3 は非公開・バージョニングなし・90日で削除', () => {
    const t = synth('dev');
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ ExpirationInDays: 90, Status: 'Enabled' })],
      },
    });
    const bucket = Object.values(t.findResources('AWS::S3::Bucket'))[0] as {
      Properties: { VersioningConfiguration?: unknown };
    };
    expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
  });

  it('外部 API キーのシークレット名：dev は登録済みの名前、stg・prod は環境名付き', () => {
    expect(externalSecretName('dev', 'navitime')).toBe('ai-schedule-app/navitime-rapidapi-key');
    expect(externalSecretName('prod', 'googleMapsServer')).toBe(
      'ai-schedule-app/prod/google-maps-api-key',
    );
  });

  it('ログ保持日数は 30・90 日のみ対応', () => {
    expect(() => toRetentionDays(45)).toThrow(/未対応/);
  });
});
