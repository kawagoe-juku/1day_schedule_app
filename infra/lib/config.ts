/** 環境ごとの設定。開発・検証・本番の差分はここに集める。 */
export interface StageConfig {
  /** 環境名（リソース名・タグ・SSM パスに使う） */
  readonly stage: 'dev' | 'stg' | 'prod';
  /** デプロイ先リージョン */
  readonly region: string;
  /** NAT Gateway 用に確保する固定 IP の数（= NAT Gateway の数） */
  readonly egressIpCount: number;
}

export const PROJECT = 'schedule-app';

export const STAGES: Record<StageConfig['stage'], StageConfig> = {
  dev: { stage: 'dev', region: 'ap-northeast-1', egressIpCount: 1 },
  stg: { stage: 'stg', region: 'ap-northeast-1', egressIpCount: 1 },
  prod: { stage: 'prod', region: 'ap-northeast-1', egressIpCount: 2 },
};

/** SSM パラメータのパス（スタック間で値を受け渡す） */
export const ssmPath = (stage: string, name: string): string => `/${PROJECT}/${stage}/${name}`;
