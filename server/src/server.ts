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
const db = config.DATABASE_URL
  ? createDbChecker(config.DATABASE_URL, {
      sslCaPath: config.DB_SSL_CA_PATH,
      // ping はリクエストを受けてから呼ばれるので、この時点では app はできている
      onError: (err) => app.log.warn({ err }, 'db check failed'),
    })
  : undefined;
const app = await buildApp({ config, db });

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return; // 停止の合図を2回受けても、終了処理は1回だけ
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // 接続が残って終了処理が長引いても、10秒で打ち切る
  setTimeout(() => process.exit(1), 10_000).unref();
  let code = 0;
  try {
    await app.close();
    await db?.close();
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    code = 1;
  }
  process.exit(code);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
