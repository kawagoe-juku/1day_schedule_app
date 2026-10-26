import { z } from 'zod';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url().optional(),
  /**
   * AWS 上では接続情報を Secrets Manager から項目ごとに受け取る（ECS の secrets）。
   * DB_HOST があれば、DATABASE_URL より優先して接続先を組み立てる。
   */
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  /** DB 接続で検証する CA 証明書のファイル（Aurora は TLS 必須。コンテナに RDS の CA を同梱） */
  DB_SSL_CA_PATH: z.string().optional(),
  /** JWT の検証先（ECS では App スタックが設定する。ローカルは .env に dev の値を書く） */
  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_WEB_CLIENT_ID: z.string().optional(),
  APP_VERSION: z.string().default('0.1.0'),
});

export type Config = z.infer<typeof ConfigSchema>;

const invalid = (message: string) => new Error(`環境変数が不正です: ${message}`);

/** 環境変数から設定を読み込む。不正な値があれば起動時に例外を投げる。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw invalid(issues);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    // 設定漏れのまま動かさない（DB なし・認証がすべて 401・TLS の検証なしを起動時に見つける）
    const missing = [
      !c.DB_HOST && !c.DATABASE_URL && 'DB_HOST または DATABASE_URL',
      !c.COGNITO_USER_POOL_ID && 'COGNITO_USER_POOL_ID',
      !c.COGNITO_WEB_CLIENT_ID && 'COGNITO_WEB_CLIENT_ID',
      !c.DB_SSL_CA_PATH && 'DB_SSL_CA_PATH',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw invalid(`本番（NODE_ENV=production）では ${missing.join('・')} が必要です`);
    }
  }
  if (!c.DB_HOST) return c;
  if (!c.DB_NAME || !c.DB_USER || !c.DB_PASSWORD) {
    throw invalid('DB_HOST を指定する場合は DB_NAME・DB_USER・DB_PASSWORD も必要です');
  }
  const user = encodeURIComponent(c.DB_USER);
  const password = encodeURIComponent(c.DB_PASSWORD);
  return {
    ...c,
    DATABASE_URL: `postgres://${user}:${password}@${c.DB_HOST}:${c.DB_PORT}/${c.DB_NAME}`,
  };
}
