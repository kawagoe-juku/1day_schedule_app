/**
 * 未適用のマイグレーション（server/drizzle/*.sql）を順に適用する。
 * 使い方：npm run db:migrate
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connectForMigration, MIGRATIONS_FOLDER, print } from './migration-client.js';

const { client, target } = await connectForMigration();
try {
  print(`マイグレーションを適用します：${target}`);
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  print('完了しました');
} finally {
  await client.end();
}
