import type { FastifyInstance } from 'fastify';
import type { DbChecker } from '../db.js';

export interface HealthOptions {
  version: string;
  db?: DbChecker;
}

/**
 * ヘルスチェック（認証不要）。
 * - ALB は /api/health を参照する（DB に触れない。開発環境の Aurora の自動停止を妨げないため）。
 * - /api/health/ready は DB への接続も確認する（手動・デプロイ後の確認用）。
 */
export async function healthRoutes(app: FastifyInstance, opts: HealthOptions): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok' as const, version: opts.version }));

  app.get('/api/health/ready', async (_request, reply) => {
    const db = opts.db ? ((await opts.db.ping()) ? 'ok' : 'ng') : 'skipped';
    const status = db === 'ng' ? 'ng' : 'ok';
    return reply.code(status === 'ok' ? 200 : 503).send({ status, checks: { db } });
  });
}
