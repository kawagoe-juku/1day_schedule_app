/**
 * Feature Flag（準備のみの機能の ON/OFF）。
 * 切り替えは環境変数だけで行う（`FEATURE_〜=true` で ON）。既定はすべて OFF。
 */
import { featureDisabled } from './errors.js';

/** 機能名と環境変数名の対応 */
export const FEATURES = {
  /** 音声入力（POST /api/speech/transcribe） */
  voiceInput: 'FEATURE_VOICE_INPUT',
  /** 通知の配信 */
  notification: 'FEATURE_NOTIFICATION',
  /** 延期再計画（POST /agent/plans/{planId}/replan） */
  postponeReplan: 'FEATURE_POSTPONE_REPLAN',
  /** 出発検知（POST /agent/plans/{planId}/departure-detected） */
  departureDetection: 'FEATURE_DEPARTURE_DETECTION',
  /** 運行情報の監視（定期実行） */
  operationMonitoring: 'FEATURE_OPERATION_MONITORING',
  /** 出発アラートの段階通知（-30/-15/-5/0分） */
  stagedNotification: 'FEATURE_STAGED_NOTIFICATION',
} as const;

export type FeatureName = keyof typeof FEATURES;
type FeatureEnvName = (typeof FEATURES)[FeatureName];

export const FEATURE_ENV_NAMES = Object.values(FEATURES) as [FeatureEnvName, ...FeatureEnvName[]];

/** 設定のうち Feature Flag の部分（config.ts の Config がこれを満たす） */
export type FeatureConfig = Record<FeatureEnvName, boolean>;

export function isFeatureEnabled(config: FeatureConfig, feature: FeatureName): boolean {
  return config[FEATURES[feature]];
}

/** OFF なら 501 FEATURE_DISABLED を投げる。準備のみの API は、処理の最初にこれを呼ぶ */
export function assertFeatureEnabled(config: FeatureConfig, feature: FeatureName): void {
  if (!isFeatureEnabled(config, feature)) throw featureDisabled();
}
