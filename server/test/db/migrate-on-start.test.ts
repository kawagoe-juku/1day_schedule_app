import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, migrateOnStart } from '../../src/db/migration-client.js';
import { testDatabaseUrl } from '../helpers/test-db.js';

/**
 * 起動時のマイグレーション（DB_MIGRATE_ON_START）。
 * 開発環境の Aurora と同じく「テーブルが1つもない DB」から始めるため、専用の空の DB を作って試す。
 */
describe('起動時のマイグレーション', () => {
  const SCRATCH_DB = 'schedule_app_migrate_on_start_test';
  const scratchUrl = (() => {
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${SCRATCH_DB}`;
    return url.href;
  })();
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
    entries: unknown[];
  };

  const withAdmin = async (run: (admin: pg.Client) => Promise<void>) => {
    const url = new URL(testDatabaseUrl());
    url.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: url.href });
    await admin.connect();
    try {
      await run(admin);
    } finally {
      await admin.end();
    }
  };
  const query = async <T extends pg.QueryResultRow>(sql: string): Promise<T[]> => {
    const client = new pg.Client({ connectionString: scratchUrl });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  };
  const state = async () => {
    const [tables] = await query<{ count: string }>(
      `select count(*) from information_schema.tables where table_schema = 'public'`,
    );
    const [applied] = await query<{ count: string }>(
      'select count(*) from drizzle.__drizzle_migrations',
    );
    return { tables: Number(tables?.count), applied: Number(applied?.count) };
  };

  beforeAll(async () => {
    await withAdmin(async (admin) => {
      await admin.query(`drop database if exists "${SCRATCH_DB}"`);
      await admin.query(`create database "${SCRATCH_DB}"`);
    });
  });
  afterAll(async () => {
    await withAdmin(async (admin) => {
      await admin.query(`drop database if exists "${SCRATCH_DB}"`);
    });
  });

  it('空の DB に、複数台が同時に起動しても、1回ずつだけ適用される', async () => {
    // ロックがないと、適用履歴の表を作るところや create table が重なって失敗する
    await Promise.all([
      migrateOnStart(scratchUrl),
      migrateOnStart(scratchUrl),
      migrateOnStart(scratchUrl),
    ]);
    expect(await state()).toEqual({ tables: 12, applied: journal.entries.length });
  });

  it('適用済みの DB では何もしない（再起動のたびに呼ばれる）', async () => {
    await migrateOnStart(scratchUrl);
    expect(await state()).toEqual({ tables: 12, applied: journal.entries.length });
  });

  it('より新しい日時のものが先に適用されていて飛ばされたら、例外にする', async () => {
    // 別のブランチのマイグレーションが先に適用された状態を作る（履歴を、ずっと先の日時の1件に置き換える）
    await query('delete from drizzle.__drizzle_migrations');
    await query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ('other-branch', 9999999999999)`,
    );
    await expect(migrateOnStart(scratchUrl)).rejects.toThrow('適用されなかったマイグレーション');
    // 失敗したあとも、順番待ちのロックは残らない
    const locks = await query<{ count: string }>(
      `select count(*) from pg_locks where locktype = 'advisory'`,
    );
    expect(Number(locks[0]?.count)).toBe(0);
  });

  it('存在しない DB を指定すると例外になる（呼び出し側が起動をやめる）', async () => {
    const url = new URL(scratchUrl);
    url.pathname = '/schedule_app_missing_test';
    await expect(migrateOnStart(url.href)).rejects.toThrow();
  });
});
