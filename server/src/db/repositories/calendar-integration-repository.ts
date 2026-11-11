import { and, asc, eq } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { calendarIntegration } from '../schema.js';

export type CalendarIntegration = typeof calendarIntegration.$inferSelect;
export type CalendarProvider = 'google' | 'outlook';
export type NewCalendarIntegration = Omit<
  typeof calendarIntegration.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;
export type CalendarIntegrationUpdate = Partial<
  Omit<NewCalendarIntegration, 'userId' | 'provider'>
>;

/** 利用者・プロバイダーごとに1件。未連携は行なし、解除は行の削除 */
export const calendarIntegrationRepository = (db: DbExecutor) => ({
  async listByUser(userId: string): Promise<CalendarIntegration[]> {
    return db
      .select()
      .from(calendarIntegration)
      .where(eq(calendarIntegration.userId, userId))
      .orderBy(asc(calendarIntegration.provider));
  },

  async findByProvider(
    userId: string,
    provider: CalendarProvider,
  ): Promise<CalendarIntegration | undefined> {
    const rows = await db
      .select()
      .from(calendarIntegration)
      .where(
        and(eq(calendarIntegration.userId, userId), eq(calendarIntegration.provider, provider)),
      );
    return rows[0];
  },

  /** 連携する。すでに連携済みなら、連携し直したものとして上書きする（連携日時も更新する） */
  async upsert(values: NewCalendarIntegration): Promise<CalendarIntegration> {
    const now = new Date();
    const rows = await db
      .insert(calendarIntegration)
      .values(values)
      .onConflictDoUpdate({
        target: [calendarIntegration.userId, calendarIntegration.provider],
        set: {
          status: values.status ?? 'connected',
          secretName: values.secretName,
          scope: values.scope ?? null,
          connectedAt: values.connectedAt ?? now,
          lastSyncedAt: values.lastSyncedAt ?? null,
          lastError: values.lastError ?? null,
          updatedAt: now,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('calendar_integration の保存に失敗しました');
    return row;
  },

  /** 同期の結果（状態・最終同期日時・直近のエラー）を記録する */
  async update(
    userId: string,
    provider: CalendarProvider,
    values: CalendarIntegrationUpdate,
  ): Promise<CalendarIntegration | undefined> {
    const rows = await db
      .update(calendarIntegration)
      .set(values)
      .where(
        and(eq(calendarIntegration.userId, userId), eq(calendarIntegration.provider, provider)),
      )
      .returning();
    return rows[0];
  },

  /** 連携解除。予定キャッシュも CASCADE で消える */
  async delete(userId: string, provider: CalendarProvider): Promise<boolean> {
    const rows = await db
      .delete(calendarIntegration)
      .where(
        and(eq(calendarIntegration.userId, userId), eq(calendarIntegration.provider, provider)),
      )
      .returning({ id: calendarIntegration.id });
    return rows.length > 0;
  },
});
