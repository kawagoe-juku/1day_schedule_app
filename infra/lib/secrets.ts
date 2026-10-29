/**
 * 外部 API キーのシークレット（Secrets Manager）。値はコードに書かず、名前とキー名だけを持つ。
 *
 * - dev は登録済みの名前（環境名なし）をそのまま使う。
 * - stg・prod は `ai-schedule-app/<stage>/<名前>` として別に登録する。
 */
export const EXTERNAL_SECRETS = {
  googleMapsServer: { name: 'google-maps-api-key', key: 'I_SCHEDULE_APP_FOR_SERVER' },
  googleMapsWeb: { name: 'google-maps-api-key_web', key: 'AI_SCHEDULE_APP_FOR_WEB' },
  navitime: { name: 'navitime-rapidapi-key', key: 'NAVITIME_RAPIDAPI_KEY' },
} as const;

export type ExternalSecret = keyof typeof EXTERNAL_SECRETS;

export function externalSecretName(stage: string, secret: ExternalSecret): string {
  const { name } = EXTERNAL_SECRETS[secret];
  return stage === 'dev' ? `ai-schedule-app/${name}` : `ai-schedule-app/${stage}/${name}`;
}

/** DB の認証情報（Data スタックが自動生成する） */
export const dbSecretName = (stage: string): string => `ai-schedule-app/${stage}/db`;

/** CloudFront から ALB への要求に付けるヘッダーの値（App スタックが自動生成する） */
export const originVerifySecretName = (stage: string): string =>
  `ai-schedule-app/${stage}/origin-verify`;
