/**
 * 未適用のマイグレーション（server/drizzle/*.sql）を順に適用する。
 * 使い方：npm run db:migrate
 */
import { applyMigrations, connectForMigration, print } from './migration-client.js';

const { client, target } = await connectForMigration();
try {
  print(`マイグレーションを適用します：${target}`);
  await applyMigrations(client);
  print('完了しました');
} finally {
  await client.end();
}
