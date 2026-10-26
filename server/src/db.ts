import { readFileSync } from 'node:fs';
import pg from 'pg';

/** DB 接続確認用の最小限のクライアント（ヘルスチェック用） */
export interface DbChecker {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** TLS 接続で検証する CA 証明書のファイル。指定時は TLS 必須で証明書を検証する */
  sslCaPath?: string;
  /** 接続確認に失敗したときの原因（TLS・認証・タイムアウトなど）を受け取る。ログ出力用 */
  onError?: (error: unknown) => void;
}

export function createDbChecker(databaseUrl: string, options: DbOptions = {}): DbChecker {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 2000,
    // 使っていない接続は10秒で閉じる（開発環境の Aurora を自動停止させるため、接続を残さない）
    idleTimeoutMillis: 10_000,
    ssl: options.sslCaPath
      ? { ca: readFileSync(options.sslCaPath, 'utf8'), rejectUnauthorized: true }
      : undefined,
  });
  return {
    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch (error) {
        options.onError?.(error);
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}
