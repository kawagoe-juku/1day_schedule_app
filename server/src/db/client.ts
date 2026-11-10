/**
 * DB 接続。サーバはこの createDb() を1回だけ呼び、リポジトリ（repositories/）に db を渡して使う。
 * 接続情報は環境変数から受け取る（AWS では ECS が Secrets Manager の値を環境変数に入れる。config.ts）。
 */
import { readFileSync } from 'node:fs';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
/** db.transaction() の中で受け取るトランザクション */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/**
 * リポジトリが受け取る実行先。db を渡せば1文ずつ、tx を渡せばそのトランザクションの中で実行する。
 * 複数の操作をまとめるとき：
 *   await db.transaction(async (tx) => { await repoA(tx).x(); await repoB(tx).y(); });
 * 途中で例外が出れば、すべて取り消される。
 */
export type DbExecutor = Db | Tx;

/** DB 接続確認（ヘルスチェック用） */
export interface DbChecker {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** TLS 接続で検証する CA 証明書のファイル。指定時は TLS 必須で証明書を検証する */
  sslCaPath?: string;
  /** 接続確認に失敗したときの原因（TLS・認証・タイムアウトなど）を受け取る。ログ出力用 */
  onError?: (error: unknown) => void;
  /** 同時に開く接続の上限（既定 10） */
  maxConnections?: number;
}

export interface DbConnection extends DbChecker {
  db: Db;
}

/** 接続確認は長く待たない（停止中の Aurora の再開を待たずに ng を返す） */
const PING_TIMEOUT_MS = 2000;
/** 通常の処理は、自動停止した開発環境の Aurora が再開するまで待てるようにする（再開に十数秒かかる） */
const CONNECTION_TIMEOUT_MS = 20_000;

export function createDb(databaseUrl: string, options: DbOptions = {}): DbConnection {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // 使っていない接続は10秒で閉じる（開発環境の Aurora を自動停止させるため、接続を残さない）
    idleTimeoutMillis: 10_000,
    ssl: options.sslCaPath
      ? { ca: readFileSync(options.sslCaPath, 'utf8'), rejectUnauthorized: true }
      : undefined,
  });
  // 待機中の接続が切れても、プロセスを落とさない（次の問い合わせで接続し直す）
  pool.on('error', (error) => options.onError?.(error));

  return {
    db: drizzle(pool, { schema, casing: 'snake_case' }),
    async ping() {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('db ping timeout')), PING_TIMEOUT_MS);
      });
      const query = pool.query('SELECT 1');
      // 打ち切った後に問い合わせが失敗しても、未処理の例外にしない
      query.catch(() => {});
      try {
        await Promise.race([query, timeout]);
        return true;
      } catch (error) {
        options.onError?.(error);
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
