/**
 * 環境ごとの設定。開発・検証・本番の差分はここに集める（WBS 2.1）。
 * 値の根拠：見積書 7章（環境別の構成）、要件定義書（バックアップ7日・ログ90日・Multi-AZ）。
 */
export interface StageConfig {
  /** 環境名（リソース名・タグ・SSM パスに使う） */
  readonly stage: 'dev' | 'stg' | 'prod';
  /** デプロイ先リージョン */
  readonly region: string;
  /** Web 版の URL（CloudFront に割り当てるドメイン名） */
  readonly appDomain: string;
  /** ネットワーク（2.2） */
  readonly network: {
    /** VPC のアドレス範囲。社内ネットワークとの重複確認（1.10）までは仮置き（U11） */
    readonly vpcCidr: string;
    /** 使う AZ の数。ALB と Aurora の要件で最低2 */
    readonly azCount: number;
    /** NAT Gateway の数（= 固定出口 IP の数） */
    readonly natGateways: number;
  };
  /** ECS Fargate（2.5） */
  readonly app: {
    readonly cpu: number;
    readonly memoryMiB: number;
    readonly minTasks: number;
    readonly maxTasks: number;
  };
  /** Aurora Serverless v2（2.3） */
  readonly database: {
    /** 最小 ACU。0 で自動一時停止（利用がないとき停止して費用を抑える） */
    readonly minAcu: number;
    readonly maxAcu: number;
    /** 別 AZ の読み取りインスタンス数（Multi-AZ のため本番は1以上） */
    readonly readers: number;
    readonly backupRetentionDays: number;
    readonly deletionProtection: boolean;
  };
  /** 監視・ログ（9.1） */
  readonly ops: {
    readonly logRetentionDays: number;
  };
}

export const PROJECT = 'schedule-app';

/** Route 53 で取得したドメイン（ホストゾーン名） */
export const ROOT_DOMAIN = 'super-ai-schedule-app.com';

export const STAGES: Record<StageConfig['stage'], StageConfig> = {
  dev: {
    stage: 'dev',
    region: 'ap-northeast-1',
    appDomain: `dev.${ROOT_DOMAIN}`,
    network: { vpcCidr: '10.100.0.0/16', azCount: 2, natGateways: 1 },
    app: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2 },
    database: {
      minAcu: 0,
      maxAcu: 2,
      readers: 0,
      backupRetentionDays: 7,
      deletionProtection: false,
    },
    ops: { logRetentionDays: 30 },
  },
  stg: {
    stage: 'stg',
    region: 'ap-northeast-1',
    appDomain: `stg.${ROOT_DOMAIN}`,
    network: { vpcCidr: '10.101.0.0/16', azCount: 2, natGateways: 1 },
    app: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2 },
    database: {
      minAcu: 0.5,
      maxAcu: 2,
      readers: 0,
      backupRetentionDays: 7,
      deletionProtection: true,
    },
    ops: { logRetentionDays: 90 },
  },
  prod: {
    stage: 'prod',
    region: 'ap-northeast-1',
    appDomain: ROOT_DOMAIN,
    network: { vpcCidr: '10.102.0.0/16', azCount: 2, natGateways: 2 },
    app: { cpu: 256, memoryMiB: 512, minTasks: 2, maxTasks: 4 },
    database: {
      minAcu: 0.5,
      maxAcu: 4,
      readers: 1,
      backupRetentionDays: 7,
      deletionProtection: true,
    },
    ops: { logRetentionDays: 90 },
  },
};

export function getStageConfig(name: string | undefined): StageConfig {
  const config = STAGES[(name ?? 'dev') as StageConfig['stage']];
  if (!config) {
    throw new Error(`未知の stage です: ${name}（dev / stg / prod のいずれか）`);
  }
  return config;
}

/** SSM パラメータのパス（スタック間で値を受け渡す） */
export const ssmPath = (stage: string, name: string): string => `/${PROJECT}/${stage}/${name}`;
