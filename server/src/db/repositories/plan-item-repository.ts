import { and, asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { planItem } from '../schema.js';

export type PlanItem = typeof planItem.$inferSelect;
export type NewPlanItem = Omit<typeof planItem.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>;

/** 計画の持ち主の確認は planRepository.findById で先に行う（ここでは planId だけで絞る） */
export const planItemRepository = (db: DbExecutor) => ({
  async insertMany(items: NewPlanItem[]): Promise<PlanItem[]> {
    if (items.length === 0) return [];
    return db.insert(planItem).values(items).returning();
  },

  /** 時系列順（sequence の昇順） */
  async listByPlan(planId: number): Promise<PlanItem[]> {
    return db
      .select()
      .from(planItem)
      .where(eq(planItem.planId, planId))
      .orderBy(asc(planItem.sequence), asc(planItem.id));
  },

  async delete(planId: number, id: number): Promise<boolean> {
    const rows = await db
      .delete(planItem)
      .where(and(eq(planItem.id, id), eq(planItem.planId, planId)))
      .returning({ id: planItem.id });
    return rows.length > 0;
  },

  /** 計画の修正・再生成で、項目をすべて入れ替えるときに使う */
  async deleteByPlan(planId: number): Promise<number> {
    const rows = await db
      .delete(planItem)
      .where(eq(planItem.planId, planId))
      .returning({ id: planItem.id });
    return rows.length;
  },
});
