/**
 * サーバが使う外部 API キーのシークレット（Secrets Manager に手動で登録する）。
 * 値はコードに書かず、シークレット名（name）と JSON のキー名（key）だけを持つ。
 *
 * - dev は `ai-schedule-app/<name>`（環境名なし）。
 * - stg・prod は `ai-schedule-app/<stage>/<name>` として別に登録する。
 * - key は登録済みシークレットの JSON のキー名そのもの（Google のキー名に合わせている）。
 * - 未登録だとサーバのタスクが起動できない（手順は infra/README.md「初回の準備」）。
 */
export const EXTERNAL_SECRETS = {
  googleMapsServer: { name: 'google-maps-api-key', key: 'I_SCHEDULE_APP_FOR_SERVER' },
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
