import { and, asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { routine } from '../schema.js';

export type Routine = typeof routine.$inferSelect;
export type NewRoutine = Omit<typeof routine.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type RoutineUpdate = Partial<Omit<NewRoutine, 'userId'>>;

export const routineRepository = (db: DbExecutor) => ({
  async create(values: NewRoutine): Promise<Routine> {
    const rows = await db.insert(routine).values(values).returning();
    const row = rows[0];
    if (!row) throw new Error('routine の作成に失敗しました');
    return row;
  },

  async findById(userId: string, id: number): Promise<Routine | undefined> {
    const rows = await db
      .select()
      .from(routine)
      .where(and(eq(routine.id, id), eq(routine.userId, userId)));
    return rows[0];
  },

  /** 登録順 */
  async listByUser(userId: string): Promise<Routine[]> {
    return db.select().from(routine).where(eq(routine.userId, userId)).orderBy(asc(routine.id));
  },

  /** 単発スキップは skippedDate に日付（日本時間）を入れ、解除は null にする */
  async update(userId: string, id: number, values: RoutineUpdate): Promise<Routine | undefined> {
    const rows = await db
      .update(routine)
      .set(values)
      .where(and(eq(routine.id, id), eq(routine.userId, userId)))
      .returning();
    return rows[0];
  },

  async delete(userId: string, id: number): Promise<boolean> {
    const rows = await db
      .delete(routine)
      .where(and(eq(routine.id, id), eq(routine.userId, userId)))
      .returning({ id: routine.id });
    return rows.length > 0;
  },
});
