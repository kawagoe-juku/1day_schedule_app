import { describe, expect, it } from 'vitest';
import { loadContext, type CalendarEntry, type CalendarSource } from '../../src/agent/context.js';

const NOW = new Date('2026-11-25T09:00:00+09:00');
type Repos = Parameters<typeof loadContext>[0];

const user = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  homeLatitude: 35.64,
  homeLongitude: 139.67,
  memoUsageConsent: true,
  calendarUsageConsent: true,
  ...overrides,
});
const routine = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  routineName: `ルーティン${id}`,
  locationName: 'ジム',
  startTime: '19:00:00',
  endTime: '20:00:00',
  skippedDate: null,
  ...overrides,
});
const entry = (id: number, overrides: Partial<CalendarEntry> = {}): CalendarEntry => ({
  id,
  date: '2026-11-25',
  title: `予定${id}`,
  isAllDay: false,
  start: new Date('2026-11-25T10:00:00+09:00'),
  end: new Date('2026-11-25T11:00:00+09:00'),
  location: '新宿駅',
  ...overrides,
});

function setup(data: {
  user?: ReturnType<typeof user>;
  routines?: unknown[];
  memos?: unknown[];
  programs?: unknown[];
  calendar?: CalendarEntry[] | (() => Promise<CalendarEntry[]>);
}) {
  const asked: string[][] = [];
  let memoReads = 0;
  const repos = {
    users: { ensure: async () => data.user ?? user() },
    routines: { listByUser: async () => data.routines ?? [] },
    memos: {
      listByUser: async () => {
        memoReads += 1;
        return data.memos ?? [];
      },
    },
    pointPrograms: { listByUser: async () => data.programs ?? [] },
  } as unknown as Repos;
  const calendar: CalendarSource = {
    async list(_userId, dates) {
      asked.push(dates);
      return typeof data.calendar === 'function' ? data.calendar() : (data.calendar ?? []);
    },
  };
  return { load: () => loadContext(repos, calendar, 'u1', NOW), asked, memoReads: () => memoReads };
}

describe('loadContext', () => {
  it('自宅の座標・有効なポイントを返す。自宅が未設定なら home は undefined', async () => {
    const ctx = await setup({
      programs: [
        { programCode: 'waon', isEnabled: true },
        { programCode: 'ponta', isEnabled: false },
      ],
    }).load();
    expect(ctx.home).toEqual({ lat: 35.64, lng: 139.67 });
    expect(ctx.programs).toEqual(['waon']);
    expect((await setup({ user: user({ homeLatitude: null }) }).load()).home).toBeUndefined();
  });

  it('カレンダーは今日と明日を取得する。終日の予定は取り込まない', async () => {
    const { load, asked } = setup({
      calendar: [entry(1), entry(2, { isAllDay: true }), entry(3, { location: null })],
    });
    const ctx = await load();
    expect(asked).toEqual([['2026-11-25', '2026-11-26']]);
    expect(ctx.events).toEqual([
      {
        ref: 'c1',
        source: 'calendar',
        date: '2026-11-25',
        title: '予定1',
        place: '新宿駅',
        start: '2026-11-25T10:00:00+09:00',
        end: '2026-11-25T11:00:00+09:00',
      },
      expect.objectContaining({ ref: 'c3', place: undefined }),
    ]);
  });

  it('カレンダーの同意が OFF なら、予定を取得しない', async () => {
    const { load, asked } = setup({
      user: user({ calendarUsageConsent: false }),
      calendar: [entry(1)],
    });
    expect((await load()).events).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('カレンダーの取得が失敗・1秒を超えたら、予定なしで続ける', async () => {
    const failed = await setup({
      calendar: () => Promise.reject(new Error('503')),
      routines: [routine(1)],
    }).load();
    expect(failed.calendarFailed).toBe(true);
    expect(failed.events.map((e) => e.ref)).toEqual(['r1', 'r1']);

    const startedAt = Date.now();
    const slow = await setup({ calendar: () => new Promise(() => {}) }).load();
    expect(slow.calendarFailed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('ルーティンは、今日と明日の予定にする。時刻の無いもの・スキップした日のものは除く', async () => {
    const ctx = await setup({
      routines: [
        routine(1),
        routine(2, { startTime: null, endTime: null }),
        routine(3, { skippedDate: '2026-11-25', locationName: null }),
      ],
    }).load();
    expect(ctx.events.map((e) => [e.ref, e.date, e.start, e.place])).toEqual([
      ['r1', '2026-11-25', '2026-11-25T19:00:00+09:00', 'ジム'],
      ['r1', '2026-11-26', '2026-11-26T19:00:00+09:00', 'ジム'],
      ['r3', '2026-11-26', '2026-11-26T19:00:00+09:00', undefined],
    ]);
  });

  it('メモは、チェック済みの行と空行を除いて渡す（20 行まで）', async () => {
    const ctx = await setup({
      memos: [
        { memoText: '牛乳\n卵\n\nパン', checkedLines: [1] },
        { memoText: Array.from({ length: 30 }, (_, i) => `品目${i}`).join('\n'), checkedLines: [] },
      ],
    }).load();
    expect(ctx.memos.slice(0, 3)).toEqual(['牛乳', 'パン', '品目0']);
    expect(ctx.memos).toHaveLength(20);
  });

  it('メモの同意が OFF なら、メモを読まない', async () => {
    const { load, memoReads } = setup({
      user: user({ memoUsageConsent: false }),
      memos: [{ memoText: '牛乳', checkedLines: [] }],
    });
    expect((await load()).memos).toEqual([]);
    expect(memoReads()).toBe(0);
  });

  it('予定は、1日あたり、開始の早い順に 20 件まで（今日の予定が、明日の枠を使わない）', async () => {
    const day = (date: string, count: number, idFrom: number) =>
      Array.from({ length: count }, (_, i) =>
        entry(idFrom + i, {
          date,
          start: new Date(Date.parse(`${date}T23:00:00+09:00`) - i * 60_000),
        }),
      );
    const ctx = await setup({
      calendar: [...day('2026-11-25', 25, 1), ...day('2026-11-26', 12, 101)],
    }).load();
    expect(ctx.events.filter((e) => e.date === '2026-11-25')).toHaveLength(20);
    expect(ctx.events.filter((e) => e.date === '2026-11-26')).toHaveLength(12);
    expect(ctx.events[0]?.ref).toBe('c25');
  });
});
