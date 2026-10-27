/**
 * 外部 API キーのシークレット（Secrets Manager）。値はコードに書かず、名前とキー名だけを持つ。
 *
 * - dev は 1.1 で登録済みの名前をそのまま使う。
 * - stg・prod は 9.6・9.7 で `ai-schedule-app/<stage>/<名前>` として別に登録する（2026-10-27 決定 P4）。
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
