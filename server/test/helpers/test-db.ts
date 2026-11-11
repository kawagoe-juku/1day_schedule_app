/**
 * テスト用 DB の仕組み（`npm run test:db` で使う）。
 * - 接続先は TEST_DATABASE_URL。未指定なら docker compose の DB の `schedule_app_test`。
 * - 開発用のデータを壊さないよう、DB 名が `_test` で終わらない接続先は拒否する。
 * - 各テストはトランザクションの中で動かし、終わったら巻き戻す（データを残さない）。
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import * as schema from '../../src/db/schema.js';

const DEFAULT_TEST_DATABASE_URL = 'postgres://app:app@localhost:5432/schedule_app_test';

export type TestDb = NodePgDatabase<typeof schema>;

/** テスト用 DB の接続先。DB 名が `_test` で終わらなければ例外にする */
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(
      `テスト用 DB の名前は英小文字・数字・_ で、_test で終わる必要があります（指定：${name || '(なし)'}）`,
    );
  }
  return url;
}

/**
 * describe の中で呼ぶと、その中の各テストをトランザクションで包む。
 * 戻り値の db()（Drizzle）と client()（pg）は、テストの中で呼ぶ。
 */
export function useTestDb(): { db: () => TestDb; client: () => pg.Client } {
  let client: pg.Client | undefined;
  let db: TestDb | undefined;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    db = drizzle(client, { schema, casing: 'snake_case' });
  });
  beforeEach(async () => {
    await client?.query('begin');
  });
  afterEach(async () => {
    await client?.query('rollback');
  });
  afterAll(async () => {
    await client?.end();
  });

  const ready = <T>(value: T | undefined): T => {
    if (!value) throw new Error('テスト用 DB に接続していません（テストの中で呼んでください）');
    return value;
  };
  return { db: () => ready(db), client: () => ready(client) };
}
