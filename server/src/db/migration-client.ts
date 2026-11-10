import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';

/** マイグレーションの SQL を置くフォルダ（server/drizzle）。src からも dist からも同じ場所を指す */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** マイグレーション用の接続を1本開く。接続先はサーバと同じ環境変数（server/.env）から決める */
export async function connectForMigration(): Promise<{ client: pg.Client; target: string }> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env がなければ何もしない
  }
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL（または DB_HOST など）が設定されていません');
  }
  const client = new pg.Client({
    connectionString: config.DATABASE_URL,
    ssl: config.DB_SSL_CA_PATH
      ? { ca: readFileSync(config.DB_SSL_CA_PATH, 'utf8'), rejectUnauthorized: true }
      : undefined,
  });
  await client.connect();
  const url = new URL(config.DATABASE_URL);
  // パスワードは出さない
  return { client, target: `${url.hostname}:${url.port || '5432'}${url.pathname}` };
}

export function print(message: string): void {
  process.stdout.write(`${message}\n`);
}
