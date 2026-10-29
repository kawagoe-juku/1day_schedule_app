/**
 * 環境ごとの設定。開発・検証・本番の差分はここに集める。
 * 値の根拠：見積書 7章（環境別の構成）、要件定義書（バックアップ7日・ログ90日・Multi-AZ）。
 */
export interface StageConfig {
  /** 環境名（リソース名・タグ・SSM パスに使う） */
  readonly stage: 'dev' | 'stg' | 'prod';
  /** デプロイ先リージョン */
  readonly region: string;
  /** Web 版の URL（CloudFront に割り当てるドメイン名） */
  readonly appDomain: string;
  /**
   * スタックを消してもデータを残すか。true のとき DB・利用者プール・ALB に削除保護を付け、
   * ログ・S3 も残す（dev は作り直しやすいよう false）
   */
  readonly retainOnDelete: boolean;
  /** ネットワーク */
  readonly network: {
    /** VPC のアドレス範囲（社内ネットワークと重ならないことを確認するまでの仮の値） */
    readonly vpcCidr: string;
    /** 使う AZ の数。ALB と Aurora の要件で最低2 */
    readonly azCount: number;
    /** NAT Gateway の数（= 固定出口 IP の数） */
    readonly natGateways: number;
  };
  /** ECS Fargate */
  readonly app: {
    readonly cpu: number;
    readonly memoryMiB: number;
    readonly minTasks: number;
    readonly maxTasks: number;
    /** ECS Exec（稼働中のコンテナに入って調査する機能）を有効にするか */
    readonly ecsExec: boolean;
  };
  /** Aurora Serverless v2 */
  readonly database: {
    /** 最小 ACU。0 で自動一時停止（利用がないとき停止して費用を抑える） */
    readonly minAcu: number;
    readonly maxAcu: number;
    /** 別 AZ の読み取りインスタンス数（Multi-AZ のため本番は1以上） */
    readonly readers: number;
    readonly backupRetentionDays: number;
  };
  /** ログ */
  readonly ops: {
    readonly logRetentionDays: number;
  };
}

export const PROJECT = 'schedule-app';

/** 計画生成に使う Bedrock のモデル（国内で処理する推論プロファイル。選定は暫定） */
export const BEDROCK_MODEL_ID = 'jp.anthropic.claude-sonnet-4-6';

/** Route 53 で取得したドメイン（ホストゾーン名） */
export const ROOT_DOMAIN = 'super-ai-schedule-app.com';

export const STAGES: Record<StageConfig['stage'], StageConfig> = {
  dev: {
    stage: 'dev',
    region: 'ap-northeast-1',
    appDomain: `dev.${ROOT_DOMAIN}`,
    retainOnDelete: false,
    network: { vpcCidr: '10.100.0.0/16', azCount: 2, natGateways: 1 },
    app: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2, ecsExec: true },
    database: {
      minAcu: 0,
      maxAcu: 2,
      readers: 0,
      backupRetentionDays: 7,
    },
    ops: { logRetentionDays: 30 },
  },
  stg: {
    stage: 'stg',
    region: 'ap-northeast-1',
    appDomain: `stg.${ROOT_DOMAIN}`,
    retainOnDelete: true,
    network: { vpcCidr: '10.101.0.0/16', azCount: 2, natGateways: 1 },
    app: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2, ecsExec: true },
    database: {
      minAcu: 0.5,
      maxAcu: 2,
      readers: 0,
      backupRetentionDays: 7,
    },
    ops: { logRetentionDays: 90 },
  },
  prod: {
    stage: 'prod',
    region: 'ap-northeast-1',
    appDomain: ROOT_DOMAIN,
    retainOnDelete: true,
    network: { vpcCidr: '10.102.0.0/16', azCount: 2, natGateways: 2 },
    app: { cpu: 256, memoryMiB: 512, minTasks: 2, maxTasks: 4, ecsExec: false },
    database: {
      minAcu: 0.5,
      maxAcu: 4,
      readers: 1,
      backupRetentionDays: 7,
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
