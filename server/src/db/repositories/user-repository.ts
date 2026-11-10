import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { user } from '../schema.js';

export type User = typeof user.$inferSelect;
/** 更新できる項目（id と作成・更新日時は除く） */
export type UserUpdate = Partial<Omit<typeof user.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>>;

export const userRepository = (db: DbExecutor) => ({
  async findById(id: string): Promise<User | undefined> {
    const rows = await db.select().from(user).where(eq(user.id, id));
    return rows[0];
  },

  /** 初回アクセス時に既定値で行を作る。すでにあれば何もしない。どちらの場合も現在の行を返す */
  async ensure(id: string): Promise<User> {
    await db.insert(user).values({ id }).onConflictDoNothing();
    const rows = await db.select().from(user).where(eq(user.id, id));
    const row = rows[0];
    if (!row) throw new Error('user の作成に失敗しました');
    return row;
  },

  async update(id: string, values: UserUpdate): Promise<User | undefined> {
    const rows = await db.update(user).set(values).where(eq(user.id, id)).returning();
    return rows[0];
  },

  /** 退会。計画・メモ・連携などの関連データも外部キーの CASCADE で消える */
  async delete(id: string): Promise<boolean> {
    const rows = await db.delete(user).where(eq(user.id, id)).returning({ id: user.id });
    return rows.length > 0;
  },
});
