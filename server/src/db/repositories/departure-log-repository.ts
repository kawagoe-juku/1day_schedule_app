import { desc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { departureLog } from '../schema.js';

export type DepartureLog = typeof departureLog.$inferSelect;
export type NewDepartureLog = Omit<
  typeof departureLog.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

/** 出発検知は準備のみ（Feature Flag OFF）。記録と一覧だけ用意する */
export const departureLogRepository = (db: DbExecutor) => ({
  async insert(values: NewDepartureLog): Promise<DepartureLog> {
    const rows = await db.insert(departureLog).values(values).returning();
    const row = rows[0];
    if (!row) throw new Error('departure_log の作成に失敗しました');
    return row;
  },

  /** 新しい順 */
  async listByUser(userId: string, limit = 50): Promise<DepartureLog[]> {
    return db
      .select()
      .from(departureLog)
      .where(eq(departureLog.userId, userId))
      .orderBy(desc(departureLog.id))
      .limit(limit);
  },
});
