import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  distanceMeters,
  type GoogleMapsClient,
  type Place,
  type PlaceSearch,
} from '../../src/adapters/google-maps.js';
import { ExternalApiError } from '../../src/adapters/http.js';
import {
  createNavitimeClient,
  type NavitimeClient,
  type TransitRoute,
  type TransitRouteRequest,
} from '../../src/adapters/navitime.js';
import { createTravel, findPlaces, findStores, type StoreAnchor } from '../../src/agent/lookup.js';
import { createFakeFetch, json } from '../helpers/fake-fetch.js';

const at = (time: string) => new Date(`2026-11-25T${time}:00+09:00`);
const HOME = { lat: 35.64, lng: 139.67 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };
/** 緯度 0.001 度は、約 111m */
const north = (base: { lat: number; lng: number }, meters: number) => ({
  lat: base.lat + meters / 111_195,
  lng: base.lng,
});

const place = (name: string, location: Place['location'], hours?: [string, string]): Place => ({
  placeId: `p-${name}`,
  name,
  address: `${name}の住所`,
  location,
  openingPeriods: hours && [
    { open: at(hours[0]).toISOString(), close: at(hours[1]).toISOString() },
  ],
});

/** Google Maps の代用品。検索は search、経路は route で差し替える */
function fakeMaps(handlers: {
  search?: (search: PlaceSearch) => Place[] | Error;
  route?: () => { distanceMeters: number; durationSeconds: number; polyline?: string } | undefined;
}) {
  const searches: PlaceSearch[] = [];
  let routes = 0;
  const maps = {
    async searchPlaces(search: PlaceSearch) {
      searches.push(search);
      const result = handlers.search?.(search) ?? [];
      if (result instanceof Error) throw result;
      return result;
    },
    async computeRoute() {
      routes += 1;
      if (!handlers.route) throw new ExternalApiError('google_maps', 'compute_routes', 'timeout');
      return handlers.route();
    },
  } as unknown as GoogleMapsClient;
  return { maps, searches, routeCalls: () => routes };
}

describe('distanceMeters', () => {
  it('2点間の直線距離を返す', () => {
    expect(distanceMeters(HOME, HOME)).toBe(0);
    expect(distanceMeters(HOME, north(HOME, 500))).toBeCloseTo(500, 0);
    // 三軒茶屋付近 → 東京駅は、およそ 10km
    expect(distanceMeters(HOME, TOKYO) / 1000).toBeCloseTo(9.9, 0);
  });
});

describe('findPlaces', () => {
  it('営業時間を取得しない指定で探し、座標の無い結果を除く', async () => {
    const { maps, searches } = fakeMaps({
      search: () => [place('東京駅', TOKYO), place('座標なし', undefined)],
    });
    await expect(findPlaces(maps, '東京駅', HOME)).resolves.toEqual([
      { placeId: 'p-東京駅', name: '東京駅', address: '東京駅の住所', location: TOKYO },
    ]);
    expect(searches[0]).toMatchObject({ query: '東京駅', near: HOME, fields: 'basic' });
  });
});

describe('findStores', () => {
  const anchors: StoreAnchor[] = [
    { id: 'home', location: HOME, before: at('12:00'), after: at('15:00') },
    { id: 'e1', location: TOKYO, before: at('12:30'), after: at('14:00') },
  ];
  const stops = [{ id: 's1', category: 'supermarket', chain: null }];
  const options = { programs: ['waon', 'ponta'] as const, pointsFirst: false };
  const allDay: [string, string] = ['00:00', '23:59'];

  it('場所ごとに、1km 以内の店を近い順で3件まで返し、立寄りの中で番号を振る', async () => {
    const { maps, searches } = fakeMaps({
      search: ({ near }) =>
        near === HOME
          ? [
              place('遠い店', north(HOME, 1200), allDay),
              place('店3', north(HOME, 300), allDay),
              place('店1', north(HOME, 100), allDay),
              place('店4', north(HOME, 400), allDay),
              place('店2', north(HOME, 200), allDay),
            ]
          : [place('駅前の店', north(TOKYO, 50), allDay)],
    });
    const { candidates, failedStopIds } = await findStores(maps, stops, anchors, options);
    expect(candidates.map((c) => `${c.candidate} ${c.anchor} ${c.store.name}`)).toEqual([
      'c1 home 店1',
      'c2 home 店2',
      'c3 home 店3',
      'c4 e1 駅前の店',
    ]);
    expect(candidates[0]).toMatchObject({
      stopId: 's1',
      distanceMeters: 100,
      when: ['before', 'after'],
    });
    expect(failedStopIds).toEqual([]);
    expect(searches).toHaveLength(2);
    expect(searches[0]).toMatchObject({ query: 'スーパー', radiusMeters: 1000 });
  });

  it('営業時間が分からない店・その時刻に営業していない店は、候補にしない', async () => {
    const { maps } = fakeMaps({
      search: ({ near }) =>
        near === HOME
          ? [
              place('営業時間なし', north(HOME, 100)),
              place('午前だけ', north(HOME, 200), ['09:00', '13:00']),
              place('夜だけ', north(HOME, 300), ['18:00', '23:00']),
            ]
          : [],
    });
    const { candidates } = await findStores(maps, stops, anchors, options);
    // 自宅の「前」は 12:00、「後」は 15:00
    expect(candidates.map((c) => [c.store.name, c.when])).toEqual([['午前だけ', ['before']]]);
  });

  it('ポイント優先で対象の店があれば、対象の店だけにする。無ければ、すべての店から選ぶ', async () => {
    const search = () => [
      place('サンプルスーパー', north(HOME, 100), allDay),
      place('イオン 三軒茶屋店', north(HOME, 800), allDay),
    ];
    const home = [anchors[0]!];
    const first = await findStores(fakeMaps({ search }).maps, stops, home, {
      ...options,
      pointsFirst: true,
    });
    expect(first.candidates.map((c) => [c.store.name, c.store.pointProgramCode])).toEqual([
      ['イオン 三軒茶屋店', 'waon'],
    ]);

    const normal = await findStores(fakeMaps({ search }).maps, stops, home, options);
    expect(normal.candidates.map((c) => c.store.name)).toEqual([
      'サンプルスーパー',
      'イオン 三軒茶屋店',
    ]);

    const none = await findStores(fakeMaps({ search }).maps, stops, home, {
      programs: ['nanaco'],
      pointsFirst: true,
    });
    expect(none.candidates).toHaveLength(2);
  });

  it('チェーンの指定があれば、検索の言葉に入れる。種別が other で指定も無ければ、探さない', async () => {
    const { maps, searches } = fakeMaps({ search: () => [] });
    const { candidates } = await findStores(
      maps,
      [
        { id: 's1', category: 'drugstore', chain: 'マツモトキヨシ' },
        { id: 's2', category: 'other', chain: null },
        { id: 's3', category: 'other', chain: '無印良品' },
      ],
      [anchors[0]!],
      options,
    );
    expect(searches.map((s) => s.query)).toEqual(['マツモトキヨシ ドラッグストア', '無印良品']);
    expect(candidates).toEqual([]);
  });

  it('置ける場所が無ければ、候補も失敗も無し', async () => {
    const { maps } = fakeMaps({});
    await expect(findStores(maps, stops, [], options)).resolves.toEqual({
      candidates: [],
      failedStopIds: [],
    });
  });

  it('検索がすべて失敗した立寄りは failedStopIds に入れ、例外にしない', async () => {
    const { maps } = fakeMaps({
      search: ({ query, near }) =>
        query === 'コンビニ' || near === TOKYO
          ? new ExternalApiError('google_maps', 'places_search_text', 'timeout')
          : [place('店1', north(HOME, 100), allDay)],
    });
    const result = await findStores(
      maps,
      [...stops, { id: 's2', category: 'convenience', chain: null }],
      anchors,
      options,
    );
    // s1 は自宅の検索だけ成功、s2 はどちらも失敗
    expect(result.candidates.map((c) => `${c.stopId} ${c.anchor}`)).toEqual(['s1 home']);
    expect(result.failedStopIds).toEqual(['s2']);
  });
});

describe('createTravel', () => {
  const options = { walkingSpeed: 'normal', priority: 'on_time' } as const;
  const walkRoute = (minutes: number) => () => ({
    distanceMeters: 800,
    durationSeconds: minutes * 60,
    polyline: 'abc',
  });

  const move = (mode: string, lineName: string, from: string, to: string) => ({
    kind: 'move' as const,
    mode,
    lineName,
    departureTime: `2026-11-25T${from}:00+09:00`,
    arrivalTime: `2026-11-25T${to}:00+09:00`,
    durationMinutes: 10,
    distanceMeters: 1000,
  });
  const point = (name: string, stationCode?: string, gateway?: string) => ({
    kind: 'point' as const,
    name,
    location: HOME,
    stationCode,
    gateway,
  });
  const transit = (sections: TransitRoute['sections'], fare?: number): TransitRoute => ({
    departureTime: '2026-11-25T12:00:00+09:00',
    arrivalTime: '2026-11-25T12:40:00+09:00',
    durationMinutes: 40,
    transferCount: 0,
    walkDistanceMeters: 500,
    fare: fare === undefined ? undefined : { ticketYen: fare + 10, icYen: fare },
    sections,
  });
  const railRoute = transit(
    [
      point('start'),
      move('walk', '徒歩', '12:00', '12:10'),
      point('三軒茶屋', '0001'),
      { ...move('local_train', '東急田園都市線', '12:10', '12:30'), boardingPosition: '前' },
      point('東京', '0002', '丸の内北口'),
      move('walk', '徒歩', '12:30', '12:40'),
      point('goal'),
    ],
    230,
  );
  const busRoute = transit([
    point('start'),
    move('local_bus', '都営バス', '12:00', '12:40'),
    point('goal'),
  ]);

  function fakeNavitime(result: TransitRoute[] | Error) {
    const requests: TransitRouteRequest[] = [];
    const navitime = {
      async searchTransitRoutes(request: TransitRouteRequest) {
        requests.push(request);
        if (result instanceof Error) throw result;
        return result;
      },
    } as unknown as NavitimeClient;
    return { navitime, requests };
  }

  it('300m 以内は、外部 API を呼ばずに徒歩の概算にする（注意の対象にしない）', async () => {
    const { maps, routeCalls } = fakeMaps({ route: walkRoute(5) });
    const { navitime, requests } = fakeNavitime([railRoute]);
    const travel = createTravel({ googleMaps: maps, navitime }, options);
    const leg = await travel({ from: HOME, to: north(HOME, 250), mode: 'train' });
    // 250m × 1.3 を時速 4.8km で歩く
    expect(leg).toMatchObject({ mode: 'walk', minutes: 5, distanceMeters: 325 });
    expect(leg.approximate).toBeUndefined();
    expect(routeCalls()).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('車・自転車は、300m 以内でも徒歩にしない', async () => {
    const { maps, routeCalls } = fakeMaps({ route: walkRoute(2) });
    const travel = createTravel({ googleMaps: maps }, options);
    const leg = await travel({ from: HOME, to: north(HOME, 250), mode: 'car' });
    expect(leg).toMatchObject({ mode: 'car', minutes: 2 });
    expect(routeCalls()).toBe(1);
  });

  it('電車は、乗換案内の結果から時刻・運賃・出口・乗車位置・駅名を作る', async () => {
    const { navitime, requests } = fakeNavitime([railRoute]);
    const travel = createTravel({ navitime }, options);
    const leg = await travel({ from: HOME, to: TOKYO, mode: 'train', arriveBy: at('12:50') });
    expect(leg).toMatchObject({
      mode: 'train',
      minutes: 40,
      departure: at('12:00'),
      arrival: at('12:40'),
      fareYen: 230,
      distanceMeters: 3000,
      stationExit: '丸の内北口',
      boardingPosition: '前',
      stations: ['三軒茶屋', '東京'],
    });
    expect(leg.steps).toHaveLength(3);
    expect(leg.steps[1]).toMatchObject({
      instruction: '東急田園都市線',
      transportMode: 'train',
      lineName: '東急田園都市線',
      fromStation: '三軒茶屋',
      toStation: '東京',
    });
    expect(leg.steps[0]).toMatchObject({ instruction: '徒歩', toStation: '三軒茶屋' });
    expect(leg.steps[0]?.fromStation).toBeUndefined();
    expect(requests[0]).toMatchObject({
      arriveBy: at('12:50'),
      walkSpeedKmh: 4.8,
      order: 'time_optimized',
    });
    expect(requests[0]?.departAt).toBeUndefined();
  });

  it('実際の応答（池袋→大宮）からも作れる。出口は、降りる駅のもの', async () => {
    const fixture: unknown = JSON.parse(
      readFileSync(new URL('../fixtures/navitime-route-transit.json', import.meta.url), 'utf8'),
    );
    const api = createFakeFetch();
    api.on('GET', 'https://navitime-route-totalnavi.p.rapidapi.com/route_transit', () =>
      json(fixture),
    );
    const navitime = createNavitimeClient({ apiKey: 'test-key', fetch: api.fetch });
    const travel = createTravel({ navitime }, options);
    const leg = await travel({
      from: { lat: 35.7295, lng: 139.7109 },
      to: { lat: 35.9064, lng: 139.6239 },
      mode: 'train',
      departAt: new Date('2026-10-27T09:00:00+09:00'),
    });
    expect(leg).toMatchObject({
      mode: 'train',
      departure: new Date('2026-10-27T09:00:00+09:00'),
      arrival: new Date('2026-10-27T09:42:00+09:00'),
      stationExit: '東口(北)',
      stations: ['池袋', '赤羽', '大宮（埼玉県）'],
    });
    expect(leg.steps.map((s) => s.transportMode)).toEqual(['walk', 'train', 'train', 'walk']);
  });

  it('節約重視は運賃の安い順、歩く速さは利用者の設定で探す', async () => {
    const { navitime, requests } = fakeNavitime([railRoute]);
    const travel = createTravel({ navitime }, { walkingSpeed: 'slow', priority: 'save_money' });
    await travel({ from: HOME, to: TOKYO, mode: 'train', departAt: at('12:00') });
    expect(requests[0]).toMatchObject({ departAt: at('12:00'), walkSpeedKmh: 3.6, order: 'fare' });
  });

  it('バスを含む経路は使わず、電車と徒歩だけの経路を選ぶ。出口が無ければ項目を出さない', async () => {
    const noExit = transit([
      point('start'),
      move('rapid_train', 'ＪＲ中央線', '12:00', '12:40'),
      point('goal'),
    ]);
    const { navitime } = fakeNavitime([busRoute, noExit]);
    const leg = await createTravel({ navitime }, options)({ from: HOME, to: TOKYO, mode: 'train' });
    expect(leg.steps[0]?.lineName).toBe('ＪＲ中央線');
    expect(leg.stationExit).toBeUndefined();
    expect(leg.boardingPosition).toBeUndefined();
    expect(leg.fareYen).toBeUndefined();
  });

  it('電車の経路が取れないとき、1.5km 以内なら徒歩の経路にする', async () => {
    const { maps } = fakeMaps({ route: walkRoute(12) });
    const { navitime } = fakeNavitime([busRoute]);
    const travel = createTravel({ googleMaps: maps, navitime }, options);
    const leg = await travel({ from: HOME, to: north(HOME, 1200), mode: 'train' });
    expect(leg).toMatchObject({ mode: 'walk', minutes: 12, distanceMeters: 800, polyline: 'abc' });
    expect(leg.approximate).toBeUndefined();
  });

  it.each([
    ['経路なし', [] as TransitRoute[]],
    ['API の失敗', new ExternalApiError('navitime', 'route_transit', 'http', 502)],
  ])(
    '電車の経路が取れず遠いとき（%s）は、概算（時速 30km＋10 分）にする',
    async (_name, result) => {
      const { maps, routeCalls } = fakeMaps({ route: walkRoute(12) });
      const { navitime } = fakeNavitime(result);
      const travel = createTravel({ googleMaps: maps, navitime }, options);
      const leg = await travel({ from: HOME, to: north(HOME, 10_000), mode: 'train' });
      // 10km × 1.3 ÷ 時速 30km ＝ 26 分、＋10 分
      expect(leg).toMatchObject({ mode: 'train', minutes: 36, approximate: true });
      expect(leg.departure).toBeUndefined();
      expect(routeCalls()).toBe(0);
    },
  );

  it('クライアントが無い環境（キー未設定）でも、概算で返す', async () => {
    const travel = createTravel({}, options);
    await expect(travel({ from: HOME, to: TOKYO, mode: 'train' })).resolves.toMatchObject({
      approximate: true,
    });
    await expect(travel({ from: HOME, to: TOKYO, mode: 'car' })).resolves.toMatchObject({
      mode: 'car',
      approximate: true,
    });
  });

  it('徒歩は Google の経路を使い、歩く速さの設定で時間を補正する', async () => {
    const leg = (walkingSpeed: 'slow' | 'normal' | 'fast', mode: 'walk' | 'bicycle' = 'walk') =>
      createTravel(
        { googleMaps: fakeMaps({ route: walkRoute(12) }).maps },
        { walkingSpeed, priority: 'on_time' },
      )({ from: HOME, to: north(HOME, 800), mode });
    expect((await leg('normal')).minutes).toBe(12);
    expect((await leg('slow')).minutes).toBe(16);
    expect((await leg('fast')).minutes).toBe(10);
    // 自転車は補正しない
    expect((await leg('slow', 'bicycle')).minutes).toBe(12);
  });

  it('Google の経路が取れないときは、概算にする', async () => {
    const travel = createTravel({ googleMaps: fakeMaps({}).maps }, options);
    const leg = await travel({ from: HOME, to: north(HOME, 2000), mode: 'walk' });
    // 2km × 1.3 を時速 4.8km で歩く
    expect(leg).toMatchObject({ mode: 'walk', minutes: 33, approximate: true });
  });

  it('電車も徒歩の経路も取れない近い区間は、徒歩の概算にする', async () => {
    const { navitime } = fakeNavitime([]);
    const travel = createTravel({ googleMaps: fakeMaps({}).maps, navitime }, options);
    const leg = await travel({ from: HOME, to: north(HOME, 1200), mode: 'train' });
    // 1.2km × 1.3 を時速 4.8km で歩く
    expect(leg).toMatchObject({ mode: 'walk', minutes: 20, approximate: true });
  });

  it('徒歩だけの乗換結果は、徒歩の移動（時刻つき）にする', async () => {
    const walkOnly = transit([
      point('start'),
      move('walk', '徒歩', '12:00', '12:40'),
      point('goal'),
    ]);
    const { navitime } = fakeNavitime([walkOnly]);
    const leg = await createTravel({ navitime }, options)({ from: HOME, to: TOKYO, mode: 'train' });
    expect(leg).toMatchObject({ mode: 'walk', departure: at('12:00'), arrival: at('12:40') });
    expect(leg.stations).toEqual([]);
  });

  it('プログラムの誤りは、概算にせず例外のままにする', async () => {
    const { navitime } = fakeNavitime(new TypeError('bug'));
    const travel = createTravel({ navitime }, options);
    await expect(travel({ from: HOME, to: TOKYO, mode: 'train' })).rejects.toThrow('bug');
  });

  it('offline の指定があれば、外部 API を呼ばずに概算で返す', async () => {
    const { maps, routeCalls } = fakeMaps({ route: walkRoute(12) });
    const { navitime, requests } = fakeNavitime([railRoute]);
    const travel = createTravel({ googleMaps: maps, navitime }, options);
    const leg = await travel({ from: HOME, to: TOKYO, mode: 'train', offline: true });
    expect(leg.approximate).toBe(true);
    expect(routeCalls() + requests.length).toBe(0);
  });
});
