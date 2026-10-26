import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDbChecker } from './db.js';

// server/.env があれば読み込む（本番は ECS の環境変数・Secrets Manager を使う）
try {
  process.loadEnvFile('.env');
} catch {
  // .env がなければ何もしない
}

const config = loadConfig();
const db = config.DATABASE_URL ? createDbChecker(config.DATABASE_URL) : undefined;
const app = await buildApp({ config, db });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db?.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
