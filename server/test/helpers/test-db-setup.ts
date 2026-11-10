/**
 * `npm run test:db` の最初に1回だけ動く準備。
 * テスト用 DB が無ければ作り、マイグレーションを最新まで適用する。
 */
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { testDatabaseUrl } from './test-db.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export default async function setup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const name = decodeURIComponent(url.pathname.slice(1));

  // 同じサーバの管理用 DB（postgres）につないで、テスト用 DB の有無を確かめる
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (cause) {
    throw new Error(
      `テスト用 DB（${url.host}）に接続できません。npm run db:up で起動しているか確認してください`,
      { cause },
    );
  }
  try {
    const found = await admin.query('select 1 from pg_database where datname = $1', [name]);
    // 名前は testDatabaseUrl() で英小文字・数字・_ だけに限定済み
    if (found.rowCount === 0) await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}
