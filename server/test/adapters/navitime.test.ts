import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExternalApiCall } from '../../src/adapters/metrics.js';
import { createNavitimeClient, toNavitimeTime } from '../../src/adapters/navitime.js';
import { createFakeFetch, hang, json, status } from '../helpers/fake-fetch.js';

const ROUTE = 'https://navitime-route-totalnavi.p.rapidapi.com/route_transit';
const AUTOCOMPLETE = 'https://navitime-transport.p.rapidapi.com/transport_node/autocomplete';

/** 1.9 の技術検証で保存した実際の応答（池袋→大宮、乗り換え1回） */
const routeFixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/navitime-route-transit.json', import.meta.url), 'utf8'),
);

const IKEBUKURO = { lat: 35.7295, lng: 139.7109 };
const OMIYA = { lat: 35.9064, lng: 139.6239 };
const departAt = new Date('2026-10-27T09:00:00+09:00');

function setup() {
  const api = createFakeFetch();
  const calls: ExternalApiCall[] = [];
  const client = createNavitimeClient({
    apiKey: 'test-key',
    fetch: api.fetch,
    timeoutMs: 20,
    sleep: async () => {},
    metrics: { record: (c) => calls.push(c) },
  });
  return { api, client, calls };
}

const OPERATIONS = [
  [
    'route_transit',
    ROUTE,
    (c) => c.searchTransitRoutes({ start: IKEBUKURO, goal: OMIYA, departAt }),
  ],
  ['transport_node_autocomplete', AUTOCOMPLETE, (c) => c.suggestStations('新宿')],
] as const satisfies ReadonlyArray<
  readonly [string, string, (c: ReturnType<typeof createNavitimeClient>) => Promise<unknown>]
>;

describe('toNavitimeTime', () => {
  it('日本時間の YYYY-MM-DDThh:mm:ss にする（日付をまたぐ場合も）', () => {
    expect(toNavitimeTime(new Date('2026-10-27T00:00:00Z'))).toBe('2026-10-27T09:00:00');
    expect(toNavitimeTime(new Date('2026-10-27T15:30:00Z'))).toBe('2026-10-28T00:30:00');
  });
});

describe('NAVITIME クライアント：乗換経路（正常）', () => {
  it('実際の応答から、時刻・乗り換え・運賃・出入口・乗車位置を取り出す', async () => {
    const { api, client, calls } = setup();
    api.on('GET', ROUTE, () => json(routeFixture));
    const routes = await client.searchTransitRoutes({ start: IKEBUKURO, goal: OMIYA, departAt });

    expect(routes).toHaveLength(1);
    const route = routes[0];
    expect(route).toMatchObject({
      departureTime: '2026-10-27T09:00:00+09:00',
      arrivalTime: '2026-10-27T09:42:00+09:00',
      durationMinutes: 42,
      transferCount: 1,
      walkDistanceMeters: 501,
      fare: { ticketYen: 440, icYen: 440 },
    });
    expect(route?.sections.map((s) => (s.kind === 'point' ? s.name : s.lineName))).toEqual([
      'start',
      '徒歩',
      '池袋',
      'ＪＲ埼京線',
      '赤羽',
      'ＪＲ高崎線',
      '大宮（埼玉県）',
      '徒歩',
      'goal',
    ]);
    expect(route?.sections[2]).toEqual({
      kind: 'point',
      name: '池袋',
      location: { lat: 35.729365, lng: 139.710138 },
      stationCode: '00005947',
      gateway: 'メトロポリタン口',
    });
    expect(route?.sections[3]).toEqual({
      kind: 'move',
      mode: 'local_train',
      lineName: 'ＪＲ埼京線',
      departureTime: '2026-10-27T09:06:00+09:00',
      arrivalTime: '2026-10-27T09:14:00+09:00',
      durationMinutes: 8,
      distanceMeters: 5500,
      trainType: '普通',
      companyName: 'ＪＲ東日本',
      direction: '大宮（埼玉県）,川越',
      boardingPosition: '前・中・後',
    });
    // 出入口の情報が無い駅（赤羽）は gateway が undefined
    expect(route?.sections[4]).toMatchObject({ name: '赤羽', gateway: undefined });
    expect(route?.sections[1]).toMatchObject({
      mode: 'walk',
      durationMinutes: 2,
      distanceMeters: 232,
    });

    expect(calls).toMatchObject([
      { service: 'navitime', operation: 'route_transit', outcome: 'success' },
    ]);
  });

  it('出発時刻・件数・RapidAPI のヘッダーを渡す', async () => {
    const { api, client } = setup();
    api.on('GET', ROUTE, () => json({ items: [] }));
    await client.searchTransitRoutes({ start: IKEBUKURO, goal: OMIYA, departAt });
    const call = api.calls[0];
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      start: '35.7295,139.7109',
      goal: '35.9064,139.6239',
      limit: '3',
      start_time: '2026-10-27T09:00:00',
    });
    expect(call?.headers.get('x-rapidapi-key')).toBe('test-key');
    expect(call?.headers.get('x-rapidapi-host')).toBe('navitime-route-totalnavi.p.rapidapi.com');
  });

  it('到着時刻・駅の ID・徒歩の速さ・並び順を指定できる（範囲外の値は丸める）', async () => {
    const { api, client } = setup();
    api.on('GET', ROUTE, () => json({ items: [] }));
    await client.searchTransitRoutes({
      start: '00005947',
      goal: '00005564',
      arriveBy: new Date('2026-10-27T14:00:00+09:00'),
      limit: 99,
      walkSpeedKmh: 9,
      order: 'fare',
    });
    expect(Object.fromEntries(api.calls[0]?.url.searchParams ?? [])).toEqual({
      start: '00005947',
      goal: '00005564',
      limit: '10',
      goal_time: '2026-10-27T14:00:00',
      walk_speed: '8.0',
      order: 'fare',
    });
  });

  it('出発時刻と到着時刻の両方を指定するとエラー（API は呼ばない）', async () => {
    const { api, client } = setup();
    await expect(
      client.searchTransitRoutes({ start: IKEBUKURO, goal: OMIYA, departAt, arriveBy: departAt }),
    ).rejects.toThrow('どちらか一方');
    expect(api.calls).toHaveLength(0);
  });

  it('経路が無ければ空の配列。徒歩だけの経路は運賃が undefined', async () => {
    const { api, client } = setup();
    api.on(
      'GET',
      ROUTE,
      () => json({ items: [] }),
      () =>
        json({
          items: [
            {
              summary: {
                move: {
                  from_time: '2026-10-27T09:00:00+09:00',
                  to_time: '2026-10-27T09:10:00+09:00',
                  time: 10,
                  walk_distance: 700,
                },
              },
              sections: [],
            },
          ],
        }),
    );
    expect(await client.searchTransitRoutes({ start: IKEBUKURO, goal: OMIYA, departAt })).toEqual(
      [],
    );
    const walkOnly = await client.searchTransitRoutes({ start: IKEBUKURO, goal: OMIYA, departAt });
    expect(walkOnly[0]).toMatchObject({ transferCount: 0, walkDistanceMeters: 700 });
    expect(walkOnly[0]?.fare).toBeUndefined();
  });

  it('応答の形が想定と違えば invalid_response', async () => {
    const { api, client } = setup();
    api.on('GET', ROUTE, () => json({ items: [{ summary: {}, sections: [] }] }));
    await expect(
      client.searchTransitRoutes({ start: IKEBUKURO, goal: OMIYA, departAt }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('NAVITIME クライアント：駅名の候補（正常）', () => {
  it('駅だけを探し、駅の ID・名前・所在地を返す', async () => {
    const { api, client, calls } = setup();
    api.on('GET', AUTOCOMPLETE, () =>
      json({
        items: [
          {
            id: '00006668',
            name: '東京',
            ruby: 'とうきょう',
            types: ['station'],
            address_name: '東京都千代田区丸の内',
            coord: { lat: 35.680805, lon: 139.767798 },
          },
          { id: '00006669', name: '東京テレポート', types: ['station'], address_name: null },
        ],
      }),
    );
    expect(await client.suggestStations(' 東京 ')).toEqual([
      {
        stationCode: '00006668',
        stationName: '東京',
        ruby: 'とうきょう',
        address: '東京都千代田区丸の内',
        location: { lat: 35.680805, lng: 139.767798 },
      },
      {
        stationCode: '00006669',
        stationName: '東京テレポート',
        ruby: undefined,
        address: undefined,
        location: undefined,
      },
    ]);
    const call = api.calls[0];
    expect(Object.fromEntries(call?.url.searchParams ?? [])).toEqual({
      word: '東京',
      type: 'station',
    });
    expect(call?.headers.get('x-rapidapi-host')).toBe('navitime-transport.p.rapidapi.com');
    expect(calls).toMatchObject([{ operation: 'transport_node_autocomplete', outcome: 'success' }]);
  });

  it('件数を絞れる', async () => {
    const { api, client } = setup();
    api.on('GET', AUTOCOMPLETE, () =>
      json({ items: ['a', 'b', 'c'].map((id) => ({ id, name: `駅${id}` })) }),
    );
    expect(await client.suggestStations('駅駅', { limit: 2 })).toHaveLength(2);
  });

  it('2文字未満は API を呼ばずに空の配列', async () => {
    const { api, client, calls } = setup();
    expect(await client.suggestStations('東')).toEqual([]);
    expect(await client.suggestStations('  ')).toEqual([]);
    expect(api.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe.each(OPERATIONS)('NAVITIME クライアント：%s の失敗', (operation, url, call) => {
  it('タイムアウト：やり直してもだめなら timeout エラー（2回と数える）', async () => {
    const { api, client, calls } = setup();
    api.on('GET', url, hang);
    await expect(call(client)).rejects.toMatchObject({
      name: 'ExternalApiError',
      service: 'navitime',
      operation,
      kind: 'timeout',
    });
    expect(calls.map((c) => [c.operation, c.outcome])).toEqual([
      [operation, 'timeout'],
      [operation, 'timeout'],
    ]);
  });

  it('5xx：1回目が失敗でも、やり直して成功すれば結果を返す', async () => {
    const { api, client, calls } = setup();
    api.on(
      'GET',
      url,
      () => status(502),
      () => json({ items: [] }),
    );
    expect(await call(client)).toEqual([]);
    expect(calls.map((c) => c.outcome)).toEqual(['server_error', 'success']);
  });

  it('5xx：やり直してもだめなら http エラー', async () => {
    const { api, client } = setup();
    api.on('GET', url, () => status(500));
    await expect(call(client)).rejects.toMatchObject({ operation, kind: 'http', status: 500 });
  });

  it('未購読・キーの誤り（403）はやり直さずに失敗する', async () => {
    const { api, client, calls } = setup();
    api.on('GET', url, () => status(403));
    await expect(call(client)).rejects.toMatchObject({ kind: 'http', status: 403 });
    expect(calls).toHaveLength(1);
  });
});
