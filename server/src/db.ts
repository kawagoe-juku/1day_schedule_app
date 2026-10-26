import pg from 'pg';

/** DB接続確認用の最小限のクライアント。DBアクセス層は WBS 3.1 で実装する。 */
export interface DbChecker {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDbChecker(databaseUrl: string): DbChecker {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 2000,
  });
  return {
    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}
