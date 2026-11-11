/**
 * 直近に適用したマイグレーションを1件だけ取り消す（server/drizzle/down/<名前>.sql を実行する）。
 * 使い方：npm run db:rollback
 * テーブルやデータを消すので、本番（NODE_ENV=production）では実行しない。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectForMigration, MIGRATIONS_FOLDER, print } from './migration-client.js';

interface JournalEntry {
  when: number;
  tag: string;
}

try {
  process.loadEnvFile('.env');
} catch {
  // .env がなければ何もしない
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('本番（NODE_ENV=production）ではロールバックを実行できません');
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
) as { entries: JournalEntry[] };

const { client, target } = await connectForMigration();
try {
  // 適用履歴は drizzle.__drizzle_migrations に入る（created_at はジャーナルの when と同じ値）
  const history = await client.query<{ exists: boolean }>(
    `select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
  );
  const applied = history.rows[0]?.exists
    ? await client.query<{ id: number; created_at: string }>(
        'select id, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1',
      )
    : undefined;
  const last = applied?.rows[0];
  if (!last) {
    print(`取り消すマイグレーションはありません：${target}`);
  } else {
    const entry = journal.entries.find((e) => e.when === Number(last.created_at));
    if (!entry) {
      throw new Error(
        `適用済みのマイグレーション（created_at=${last.created_at}）が server/drizzle/meta/_journal.json にありません`,
      );
    }
    const downSql = readFileSync(join(MIGRATIONS_FOLDER, 'down', `${entry.tag}.sql`), 'utf8');
    print(`マイグレーションを取り消します：${entry.tag}（${target}）`);
    // 途中で失敗したら、取り消しも履歴の削除もなかったことにする
    await client.query('begin');
    try {
      await client.query(downSql);
      await client.query('delete from drizzle.__drizzle_migrations where id = $1', [last.id]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
    print('完了しました');
  }
} finally {
  await client.end();
}
