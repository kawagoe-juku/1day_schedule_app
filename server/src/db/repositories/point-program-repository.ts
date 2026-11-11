import { asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { pointProgram } from '../schema.js';

export type PointProgram = typeof pointProgram.$inferSelect;
export type PointProgramCode = 'rakuten' | 'vpoint' | 'dpoint' | 'ponta' | 'waon' | 'nanaco';

export const pointProgramRepository = (db: DbExecutor) => ({
  async listByUser(userId: string): Promise<PointProgram[]> {
    return db
      .select()
      .from(pointProgram)
      .where(eq(pointProgram.userId, userId))
      .orderBy(asc(pointProgram.programCode));
  },

  /** 有効・無効を保存する（行が無ければ作る） */
  async set(
    userId: string,
    programCode: PointProgramCode,
    isEnabled: boolean,
  ): Promise<PointProgram> {
    const rows = await db
      .insert(pointProgram)
      .values({ userId, programCode, isEnabled })
      .onConflictDoUpdate({
        target: [pointProgram.userId, pointProgram.programCode],
        set: { isEnabled, updatedAt: new Date() },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('point_program の保存に失敗しました');
    return row;
  },
});
