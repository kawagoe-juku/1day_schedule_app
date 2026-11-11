import { asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { slotEvaluation } from '../schema.js';

export type SlotEvaluation = typeof slotEvaluation.$inferSelect;
export type NewSlotEvaluation = Omit<
  typeof slotEvaluation.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

export const slotEvaluationRepository = (db: DbExecutor) => ({
  async insertMany(items: NewSlotEvaluation[]): Promise<SlotEvaluation[]> {
    if (items.length === 0) return [];
    return db.insert(slotEvaluation).values(items).returning();
  },

  /** 評価順 */
  async listByPlan(planId: number): Promise<SlotEvaluation[]> {
    return db
      .select()
      .from(slotEvaluation)
      .where(eq(slotEvaluation.planId, planId))
      .orderBy(asc(slotEvaluation.evaluationOrder), asc(slotEvaluation.id));
  },
});
