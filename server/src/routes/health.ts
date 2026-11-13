import type { FastifyInstance } from 'fastify';
import type { DbChecker } from '../db/client.js';

/**
 * ヘルスチェックと画面向けの設定（認証不要：config.public）。
 * - ALB は /api/health を参照する（DB に触れない。開発環境の Aurora の自動停止を妨げないため）。
 * - /api/health/ready は DB への接続も確認する（手動・デプロイ後の確認用）。
 */
export async function healthRoutes(
  app: FastifyInstance,
  opts: { version: string; db?: DbChecker; cognito?: { userPoolId: string; webClientId: string } },
): Promise<void> {
  app.get('/api/health', { config: { public: true } }, async () => ({
    status: 'ok' as const,
    version: opts.version,
  }));

  app.get('/api/health/ready', { config: { public: true } }, async (_request, reply) => {
    const db = opts.db ? ((await opts.db.ping()) ? 'ok' : 'ng') : 'skipped';
    const status = db === 'ng' ? 'ng' : 'ok';
    return reply.code(status === 'ok' ? 200 : 503).send({ status, checks: { db } });
  });

  // 画面がログイン前に取得する設定。値はブラウザに渡す前提の公開情報だけ
  app.get('/api/config', { config: { public: true } }, async () => {
    if (!opts.cognito) throw new Error('COGNITO_USER_POOL_ID・COGNITO_WEB_CLIENT_ID が未設定です');
    const { userPoolId, webClientId } = opts.cognito;
    // User Pool ID の先頭がリージョン（例：ap-northeast-1_xxxxxxxxx）
    return { cognito: { region: userPoolId.split('_')[0], userPoolId, webClientId } };
  });
}
