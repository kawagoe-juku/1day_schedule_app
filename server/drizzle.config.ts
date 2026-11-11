import { defineConfig } from 'drizzle-kit';

// `npm run db:generate`（スキーマ定義から SQL を作る）のための設定。DB には接続しない。
// 適用と取り消しは src/db/migrate.ts・rollback.ts で行う。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // TypeScript の camelCase を DB の snake_case に変換する
  casing: 'snake_case',
});
