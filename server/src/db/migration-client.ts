import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { loadConfig } from '../config.js';

/** マイグレーションの SQL を置くフォルダ（server/drizzle）。src からも dist からも同じ場所を指す */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * 適用中に取る DB のロックの番号（pg_advisory_lock）。
 * サーバを複数台同時に起動しても、適用するのは1台だけにする。値に意味はなく、他の用途と重ならなければよい。
 */
const MIGRATION_LOCK_KEY = 4584474537;

/**
 * 接続を待つ上限。Aurora が休止から復帰するまで（十数秒〜）は待てる長さにする。
 * 上限がないと、DB に届かないとき（設定の誤りなど）に黙って待ち続ける。
 */
const CONNECTION_TIMEOUT_MS = 60_000;

/**
 * テーブルのロックを待つ上限。テーブル定義の変更は、稼働中のサーバの処理が終わるのを待つ。
 * 待っている間は、そのテーブルへの通常の問い合わせも後ろに並んで止まるので、長くは待たずに失敗させる。
 */
const LOCK_TIMEOUT = '10s';

interface JournalEntry {
  when: number;
  tag: string;
}

/**
 * 適用されていないマイグレーションの名前を返す（すべて適用済みなら空）。
 *
 * Drizzle は「適用済みの最新より日時（when）が新しいもの」だけを適用する。別々のブランチで作った
 * マイグレーションが日時の逆順で取り込まれると、古いほうは飛ばされたままになるので、ここで見つける。
 * DB のほうが進んでいる場合（前の版に戻したとき）は問題にしない。
 */
export function findUnapplied(
  journal: readonly JournalEntry[],
  appliedCreatedAt: readonly (string | number)[],
): string[] {
  const applied = new Set(appliedCreatedAt.map(Number));
  return journal.filter((entry) => !applied.has(entry.when)).map((entry) => entry.tag);
}

/** マイグレーション用の接続を作る（まだつながない）。Aurora は TLS 必須なので、CA 証明書があれば接続先を検証する */
export function createMigrationClient(databaseUrl: string, sslCaPath?: string): pg.Client {
  return new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: sslCaPath ? { ca: readFileSync(sslCaPath, 'utf8'), rejectUnauthorized: true } : undefined,
  });
}

/**
 * 未適用のマイグレーションを順に適用する。適用済みなら何もしない。
 * 同時に呼ばれた場合は、ロックで1つずつ順番に動かす（後から動いた側は、適用済みなので何もしない）。
 * 適用のあと、一覧（meta/_journal.json）のすべてが適用済みかを確かめ、漏れがあれば例外にする。
 */
export async function applyMigrations(client: pg.Client): Promise<void> {
  await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    // 順番待ちのロック（上の1行）を取ってから設定する。先に設定すると、順番待ちまで打ち切ってしまう
    await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

    const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
      entries: JournalEntry[];
    };
    const applied = await client.query<{ created_at: string }>(
      'select created_at from drizzle.__drizzle_migrations',
    );
    const unapplied = findUnapplied(
      journal.entries,
      applied.rows.map((row) => row.created_at),
    );
    if (unapplied.length > 0) {
      throw new Error(
        `適用されなかったマイグレーションがあります：${unapplied.join('・')}。` +
          'より新しい日時のマイグレーションが先に適用されています。SQL を作り直してください（npm run db:generate）',
      );
    }
  } finally {
    // 接続が切れていて解除に失敗しても、元の失敗を隠さない（ロックは接続が切れた時点で外れる）
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
  }
}

/**
 * サーバの起動時に適用する（DB_MIGRATE_ON_START=true のとき）。
 * 失敗したら例外を投げる。呼び出し側は起動をやめる（ECS が前の版に戻す）。
 */
export async function migrateOnStart(databaseUrl: string, sslCaPath?: string): Promise<void> {
  const client = createMigrationClient(databaseUrl, sslCaPath);
  await client.connect();
  try {
    await applyMigrations(client);
  } finally {
    await client.end();
  }
}

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
  const client = createMigrationClient(config.DATABASE_URL, config.DB_SSL_CA_PATH);
  await client.connect();
  const url = new URL(config.DATABASE_URL);
  // パスワードは出さない
  return { client, target: `${url.hostname}:${url.port || '5432'}${url.pathname}` };
}

export function print(message: string): void {
  process.stdout.write(`${message}\n`);
}
