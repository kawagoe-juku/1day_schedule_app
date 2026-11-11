import { and, desc, eq, lt } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { memo } from '../schema.js';

export type Memo = typeof memo.$inferSelect;
export type NewMemo = Omit<typeof memo.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>;
export type MemoUpdate = Partial<Omit<NewMemo, 'userId'>>;

export const memoRepository = (db: DbExecutor) => ({
  async create(values: NewMemo): Promise<Memo> {
    const rows = await db.insert(memo).values(values).returning();
    const row = rows[0];
    if (!row) throw new Error('memo の作成に失敗しました');
    return row;
  },

  async findById(userId: string, id: number): Promise<Memo | undefined> {
    const rows = await db
      .select()
      .from(memo)
      .where(and(eq(memo.id, id), eq(memo.userId, userId)));
    return rows[0];
  },

  /** 新しい順 */
  async listByUser(userId: string): Promise<Memo[]> {
    return db
      .select()
      .from(memo)
      .where(eq(memo.userId, userId))
      .orderBy(desc(memo.createdAt), desc(memo.id));
  },

  async update(userId: string, id: number, values: MemoUpdate): Promise<Memo | undefined> {
    const rows = await db
      .update(memo)
      .set(values)
      .where(and(eq(memo.id, id), eq(memo.userId, userId)))
      .returning();
    return rows[0];
  },

  async delete(userId: string, id: number): Promise<boolean> {
    const rows = await db
      .delete(memo)
      .where(and(eq(memo.id, id), eq(memo.userId, userId)))
      .returning({ id: memo.id });
    return rows.length > 0;
  },

  /** 自動削除バッチ用：指定の日時より前に作ったメモを、利用者を問わず消す。消した件数を返す */
  async deleteCreatedBefore(before: Date): Promise<number> {
    const rows = await db.delete(memo).where(lt(memo.createdAt, before)).returning({ id: memo.id });
    return rows.length;
  },
});
