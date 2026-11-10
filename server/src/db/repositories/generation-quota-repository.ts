import { and, eq, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { generationQuota } from '../schema.js';

/** 日付はすべて日本時間の YYYY-MM-DD */
export const generationQuotaRepository = (db: DbExecutor) => ({
  /** その日に数えた生成回数（まだ無ければ 0） */
  async getUsedCount(userId: string, quotaDate: string): Promise<number> {
    const rows = await db
      .select({ usedCount: generationQuota.usedCount })
      .from(generationQuota)
      .where(and(eq(generationQuota.userId, userId), eq(generationQuota.quotaDate, quotaDate)));
    return rows[0]?.usedCount ?? 0;
  },

  /**
   * 回数を1増やし、増やした後の回数を返す。
   * 1つの SQL で行うので、同時に呼ばれても数え漏れない。
   */
  async increment(userId: string, quotaDate: string): Promise<number> {
    const rows = await db
      .insert(generationQuota)
      .values({ userId, quotaDate, usedCount: 1 })
      .onConflictDoUpdate({
        target: [generationQuota.userId, generationQuota.quotaDate],
        set: { usedCount: sql`${generationQuota.usedCount} + 1`, updatedAt: new Date() },
      })
      .returning({ usedCount: generationQuota.usedCount });
    const row = rows[0];
    if (!row) throw new Error('generation_quota の更新に失敗しました');
    return row.usedCount;
  },

  /** 日次バッチ用：指定の日付より前の行を消す。消した件数を返す */
  async deleteBefore(quotaDate: string): Promise<number> {
    const rows = await db
      .delete(generationQuota)
      .where(lt(generationQuota.quotaDate, quotaDate))
      .returning({ userId: generationQuota.userId });
    return rows.length;
  },
});
