import type { FastifyInstance } from 'fastify';
import { unauthorized } from '../errors.js';

/** UNIX 秒を日本時間の ISO 8601（例 2026-11-02T13:00:00+09:00）にする（API 仕様の日時の形式） */
export function toJstIso(unixSeconds: number): string {
  const jst = new Date((unixSeconds + 9 * 3600) * 1000);
  return `${jst.toISOString().slice(0, 19)}+09:00`;
}

/** ログイン状態の確認（DB を使わない。開発環境の疎通確認と画面のログイン確認に使う） */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/session', async (request) => {
    if (!request.user) throw unauthorized();
    return { userId: request.user.sub, expiresAt: toJstIso(request.user.exp) };
  });
}
