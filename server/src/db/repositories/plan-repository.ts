import { and, desc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { plan } from '../schema.js';

export type Plan = typeof plan.$inferSelect;
export type NewPlan = Omit<typeof plan.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type PlanUpdate = Partial<Omit<NewPlan, 'userId'>>;

/** 他の利用者の計画は「無い」ものとして扱うため、取得・更新・削除は必ず userId も条件にする */
export const planRepository = (db: DbExecutor) => ({
  async create(values: NewPlan): Promise<Plan> {
    const rows = await db.insert(plan).values(values).returning();
    const row = rows[0];
    if (!row) throw new Error('plan の作成に失敗しました');
    return row;
  },

  async findById(userId: string, id: number): Promise<Plan | undefined> {
    const rows = await db
      .select()
      .from(plan)
      .where(and(eq(plan.id, id), eq(plan.userId, userId)));
    return rows[0];
  },

  /** 新しい順 */
  async listByUser(userId: string, limit = 50): Promise<Plan[]> {
    return db
      .select()
      .from(plan)
      .where(eq(plan.userId, userId))
      .orderBy(desc(plan.createdAt), desc(plan.id))
      .limit(limit);
  },

  async update(userId: string, id: number, values: PlanUpdate): Promise<Plan | undefined> {
    const rows = await db
      .update(plan)
      .set(values)
      .where(and(eq(plan.id, id), eq(plan.userId, userId)))
      .returning();
    return rows[0];
  },

  /** 行動項目・スロット評価・AI対話履歴も CASCADE で消える */
  async delete(userId: string, id: number): Promise<boolean> {
    const rows = await db
      .delete(plan)
      .where(and(eq(plan.id, id), eq(plan.userId, userId)))
      .returning({ id: plan.id });
    return rows.length > 0;
  },
});
