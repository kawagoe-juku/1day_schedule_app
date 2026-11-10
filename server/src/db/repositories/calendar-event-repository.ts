import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { DbExecutor } from '../client.js';
import { calendarEvent } from '../schema.js';

export type CalendarEvent = typeof calendarEvent.$inferSelect;
export type NewCalendarEvent = Omit<
  typeof calendarEvent.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

export const calendarEventRepository = (db: DbExecutor) => ({
  /** その日（日本時間の日付 YYYY-MM-DD）の予定。開始時刻の順 */
  async listByUserAndDate(userId: string, eventDate: string): Promise<CalendarEvent[]> {
    return db
      .select()
      .from(calendarEvent)
      .where(and(eq(calendarEvent.userId, userId), eq(calendarEvent.eventDate, eventDate)))
      .orderBy(asc(calendarEvent.startTime), asc(calendarEvent.id));
  },

  /** 同期した予定を保存する。同じ予定（連携・外部イベントID・日付）がすでにあれば内容を更新する */
  async upsertMany(events: NewCalendarEvent[]): Promise<CalendarEvent[]> {
    if (events.length === 0) return [];
    return db
      .insert(calendarEvent)
      .values(events)
      .onConflictDoUpdate({
        target: [
          calendarEvent.calendarIntegrationId,
          calendarEvent.externalEventId,
          calendarEvent.eventDate,
        ],
        set: {
          eventTitle: sql`excluded.event_title`,
          isAllDay: sql`excluded.is_all_day`,
          startTime: sql`excluded.start_time`,
          endTime: sql`excluded.end_time`,
          location: sql`excluded.location`,
          updatedAt: new Date(),
        },
      })
      .returning();
  },

  /** 同期で、連携先から消えた予定を落とすために、その日の分をいったん消す */
  async deleteByIntegrationAndDate(
    calendarIntegrationId: number,
    eventDate: string,
  ): Promise<number> {
    const rows = await db
      .delete(calendarEvent)
      .where(
        and(
          eq(calendarEvent.calendarIntegrationId, calendarIntegrationId),
          eq(calendarEvent.eventDate, eventDate),
        ),
      )
      .returning({ id: calendarEvent.id });
    return rows.length;
  },

  /** 削除バッチ用：指定の日付（日本時間）より前の予定を、利用者を問わず消す。消した件数を返す */
  async deleteBefore(eventDate: string): Promise<number> {
    const rows = await db
      .delete(calendarEvent)
      .where(lt(calendarEvent.eventDate, eventDate))
      .returning({ id: calendarEvent.id });
    return rows.length;
  },
});
