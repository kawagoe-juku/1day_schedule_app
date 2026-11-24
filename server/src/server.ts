import { createCognitoUserClient } from './adapters/cognito.js';
import { createExternalClients } from './adapters/index.js';
import { createEmfMetrics } from './adapters/metrics.js';
import { createAi } from './agent/ai.js';
import { buildApp, toLoggableError } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { migrateOnStart } from './db/migration-client.js';
import { userRepository } from './db/repositories/user-repository.js';

// server/.env があれば読み込む（本番は ECS の環境変数・Secrets Manager を使う）
try {
  process.loadEnvFile('.env');
} catch {
  // .env がなければ何もしない
}

const config = loadConfig();
const db = config.DATABASE_URL
  ? createDb(config.DATABASE_URL, {
      sslCaPath: config.DB_SSL_CA_PATH,
      // 接続の失敗はリクエストを受けてから起きるので、この時点では app はできている
      onError: (err) => app.log.warn({ err }, 'db connection failed'),
    })
  : undefined;
// 計画生成では、全体の期限（13 秒）に収めるため、外部 API を短いタイムアウト・リトライなしで呼ぶ
const agentClients = createExternalClients(config, { timeoutMs: 2500, retries: 0 });
const metrics = createEmfMetrics({ stage: config.APP_STAGE });

const app = await buildApp({
  config,
  db,
  plans: {
    db: db?.db,
    ai: config.BEDROCK_MODEL_ID
      ? createAi({ modelId: config.BEDROCK_MODEL_ID, region: config.AWS_REGION, metrics })
      : undefined,
    googleMaps: agentClients.googleMaps,
    navitime: agentClients.navitime,
  },
  users: db ? userRepository(db.db) : undefined,
  external: createExternalClients(config),
  cognito: config.COGNITO_USER_POOL_ID
    ? createCognitoUserClient({
        userPoolId: config.COGNITO_USER_POOL_ID,
        metrics,
      })
    : undefined,
});

let shuttingDown = false;
/** マイグレーションを始めた時刻（適用中だけ値が入る） */
let migrationStartedAt: number | undefined;
const shutdown = async (signal: string) => {
  if (shuttingDown) return; // 停止の合図を2回受けても、終了処理は1回だけ
  shuttingDown = true;
  if (migrationStartedAt !== undefined) {
    // 適用が長引くと、ヘルスチェックに通らないまま ECS に止められる。原因がログから分かるようにする
    app.log.error({ signal, elapsedMs: Date.now() - migrationStartedAt }, 'migration interrupted');
  }
  app.log.info({ signal }, 'shutting down');
  // 接続が残って終了処理が長引いても、10秒で打ち切る
  setTimeout(() => process.exit(1), 10_000).unref();
  // マイグレーションの途中で止められたときは、失敗として終わる
  let code = migrationStartedAt === undefined ? 0 : 1;
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

if (config.DB_MIGRATE_ON_START && config.DATABASE_URL) {
  // テーブル定義を先に最新にしてから受付を始める。失敗したら起動しない（ECS が前の版に戻す）
  migrationStartedAt = Date.now();
  app.log.info('applying migrations');
  try {
    await migrateOnStart(config.DATABASE_URL, config.DB_SSL_CA_PATH);
    app.log.info({ durationMs: Date.now() - migrationStartedAt }, 'migrations applied');
  } catch (err) {
    // PostgreSQL のエラー本文（「テーブルが既にある」「権限がない」など）も残す。
    // テーブル定義の変更が対象で、利用者の入力は含まれない（detail は出さない）
    const reason =
      err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
    app.log.fatal({ ...toLoggableError(err), reason }, 'migration failed');
    await db?.close().catch(() => {});
    process.exit(1);
  }
  migrationStartedAt = undefined;
}

await app.listen({ host: config.HOST, port: config.PORT });
