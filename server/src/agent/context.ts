/**
 * 計画生成の文脈の読み込み：プロファイル、ルーティン、メモ、有効なポイント、カレンダーの予定。
 * 同意が OFF のメモ・予定、スキップした日のルーティン、チェック済みのメモの行は、ここで落とす
 * （AI にも、下書きにも渡さない）。
 */
import type { LatLng } from '../adapters/google-maps.js';
import type { Repositories } from '../db/repositories/index.js';
import type { PointProgramCode } from '../db/repositories/point-program-repository.js';
import type { User } from '../db/repositories/user-repository.js';
import { jstDate, toIso, type PlanEvent } from './draft.js';

/** AI に渡す件数の上限（予定は1日あたり） */
const MAX_MEMO_LINES = 20;
const MAX_EVENTS = 20;
/** カレンダーの取得を待つ時間。超えたら、予定なしで続ける */
const CALENDAR_TIMEOUT_MS = 1000;

export interface CalendarEntry {
  id: number;
  /** YYYY-MM-DD（日本時間） */
  date: string;
  title: string;
  isAllDay: boolean;
  start: Date;
  end: Date;
  location?: string | null;
}

/**
 * カレンダーの予定の取得元（差し替え口）。
 * いまは、同期済みの予定（calendar_event）を読む。連携先から毎回取得する実装は 8.1・8.2 で入れる
 */
export interface CalendarSource {
  list(userId: string, dates: string[]): Promise<CalendarEntry[]>;
}

export const storedCalendar = (repos: Pick<Repositories, 'calendarEvents'>): CalendarSource => ({
  async list(userId, dates) {
    const days = await Promise.all(
      dates.map((date) => repos.calendarEvents.listByUserAndDate(userId, date)),
    );
    return days.flat().map((e) => ({
      id: e.id,
      date: e.eventDate,
      title: e.eventTitle,
      isAllDay: e.isAllDay,
      start: e.startTime,
      end: e.endTime,
      location: e.location,
    }));
  },
});

export interface PlanContext {
  user: User;
  /** 自宅の座標（未設定なら undefined。計画は作れない） */
  home?: LatLng;
  /** 有効にしているポイント */
  programs: PointProgramCode[];
  /** メモの行（同意 ON。チェック済みの行を除く） */
  memos: string[];
  /** 今日と明日の予定（カレンダーは同意 ON のときだけ。終日の予定・時刻の無いルーティンを除く） */
  events: PlanEvent[];
  /** カレンダーの取得に失敗した（予定なしで続ける） */
  calendarFailed: boolean;
}

type Repos = Pick<Repositories, 'users' | 'routines' | 'memos' | 'pointPrograms'>;

export async function loadContext(
  repos: Repos,
  calendar: CalendarSource,
  userId: string,
  now: Date,
): Promise<PlanContext> {
  const user = await repos.users.ensure(userId);
  const dates = [jstDate(now), jstDate(new Date(now.getTime() + 24 * 3600_000))];
  let calendarFailed = false;
  const entries = user.calendarUsageConsent
    ? Promise.race([
        calendar.list(userId, dates),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('calendar timeout')), CALENDAR_TIMEOUT_MS).unref();
        }),
      ]).catch(() => {
        calendarFailed = true;
        return [] as CalendarEntry[];
      })
    : Promise.resolve([]);
  const [routines, memos, programs, calendarEntries] = await Promise.all([
    repos.routines.listByUser(userId),
    user.memoUsageConsent ? repos.memos.listByUser(userId) : [],
    repos.pointPrograms.listByUser(userId),
    entries,
  ]);

  const events: PlanEvent[] = [
    ...calendarEntries
      .filter((e) => !e.isAllDay)
      .map((e) => ({
        ref: `c${e.id}`,
        source: 'calendar' as const,
        date: e.date,
        title: e.title,
        place: e.location ?? undefined,
        start: toIso(e.start),
        end: toIso(e.end),
      })),
    ...dates.flatMap((date) =>
      routines.flatMap((r) =>
        r.startTime && r.endTime && r.skippedDate !== date
          ? [
              {
                ref: `r${r.id}`,
                source: 'routine' as const,
                date,
                title: r.routineName,
                place: r.locationName ?? undefined,
                start: `${date}T${r.startTime.slice(0, 5)}:00+09:00`,
                end: `${date}T${r.endTime.slice(0, 5)}:00+09:00`,
              },
            ]
          : [],
      ),
    ),
  ].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  return {
    user,
    home:
      user.homeLatitude !== null && user.homeLongitude !== null
        ? { lat: user.homeLatitude, lng: user.homeLongitude }
        : undefined,
    programs: programs.filter((p) => p.isEnabled).map((p) => p.programCode as PointProgramCode),
    memos: memos
      .flatMap((m) =>
        m.memoText.split('\n').filter((line, i) => line.trim() && !m.checkedLines.includes(i)),
      )
      .slice(0, MAX_MEMO_LINES),
    // 1日あたり 20 件まで（開始の早い順）
    events: dates.flatMap((date) => events.filter((e) => e.date === date).slice(0, MAX_EVENTS)),
    calendarFailed,
  };
}
