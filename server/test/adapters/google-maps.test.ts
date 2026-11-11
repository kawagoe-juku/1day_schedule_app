import { describe, expect, it } from 'vitest';
import { createGoogleMapsClient } from '../../src/adapters/google-maps.js';
import type { ExternalApiCall } from '../../src/adapters/metrics.js';
import { createFakeFetch, hang, json, status } from '../helpers/fake-fetch.js';

const GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const AUTOCOMPLETE = 'https://places.googleapis.com/v1/places:autocomplete';
const SEARCH_TEXT = 'https://places.googleapis.com/v1/places:searchText';
const PLACE = 'https://places.googleapis.com/v1/places/ChIJ-test';
const ROUTES = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const TOKYO = { lat: 35.6812, lng: 139.7671 };
const SHIBUYA = { lat: 35.658, lng: 139.7016 };

function setup() {
  const api = createFakeFetch();
  const calls: ExternalApiCall[] = [];
  const client = createGoogleMapsClient({
    apiKey: 'test-key',
    fetch: api.fetch,
    timeoutMs: 20,
    sleep: async () => {},
    metrics: { record: (c) => calls.push(c) },
  });
  return { api, client, calls };
}

/** 各 API を1回呼ぶ関数（タイムアウト・5xx の確認を全 API で同じように行うため） */
const OPERATIONS = [
  ['geocode', 'GET', GEOCODE, (c) => c.geocode('東京駅')],
  ['places_autocomplete', 'POST', AUTOCOMPLETE, (c) => c.suggestAddresses('東京都千代田')],
  ['place_details', 'GET', PLACE, (c) => c.getPlace('ChIJ-test')],
  ['places_search_text', 'POST', SEARCH_TEXT, (c) => c.searchPlaces({ query: 'スーパー' })],
  [
    'compute_routes',
    'POST',
    ROUTES,
    (c) => c.computeRoute({ origin: TOKYO, destination: SHIBUYA, mode: 'walk' }),
  ],
] as const satisfies ReadonlyArray<
  readonly [
    string,
    string,
    string,
    (c: ReturnType<typeof createGoogleMapsClient>) => Promise<unknown>,
  ]
>;

describe('Google Maps クライアント：正常', () => {
  it('geocode：住所を座標にする（日本語・日本を指定）', async () => {
    const { api, client, calls } = setup();
    api.on('GET', GEOCODE, () =>
      json({
        status: 'OK',
        results: [
          {
            place_id: 'ChIJ-tokyo',
            formatted_address: '日本、〒100-0005 東京都千代田区丸の内１丁目',
            geometry: { location: TOKYO },
          },
        ],
      }),
    );
    expect(await client.geocode('東京駅')).toEqual({
      placeId: 'ChIJ-tokyo',
      formattedAddress: '日本、〒100-0005 東京都千代田区丸の内１丁目',
      location: TOKYO,
    });
    const query = api.calls[0]?.url.searchParams;
    expect(query?.get('address')).toBe('東京駅');
    expect(query?.get('language')).toBe('ja');
    expect(query?.get('region')).toBe('jp');
    expect(query?.get('key')).toBe('test-key');
    expect(calls).toMatchObject([
      { service: 'google_maps', operation: 'geocode', outcome: 'success' },
    ]);
  });

  it('geocode：見つからなければ undefined', async () => {
    const { api, client } = setup();
    api.on('GET', GEOCODE, () => json({ status: 'ZERO_RESULTS', results: [] }));
    expect(await client.geocode('存在しない住所')).toBeUndefined();
  });

  it('geocode：HTTP 200 でも status がエラー（キーの制限違反など）なら失敗にする', async () => {
    const { api, client } = setup();
    api.on('GET', GEOCODE, () => json({ status: 'REQUEST_DENIED', results: [] }));
    await expect(client.geocode('東京駅')).rejects.toMatchObject({
      name: 'ExternalApiError',
      kind: 'invalid_response',
    });
  });

  it('suggestAddresses：住所の候補を返す（キーはヘッダーで渡す）', async () => {
    const { api, client } = setup();
    api.on('POST', AUTOCOMPLETE, () =>
      json({
        suggestions: [
          { placePrediction: { placeId: 'p1', text: { text: '東京都千代田区丸の内1丁目' } } },
          { queryPrediction: { text: { text: '東京都 ラーメン' } } },
          { placePrediction: { placeId: 'p2', text: { text: '東京都千代田区大手町' } } },
        ],
      }),
    );
    expect(await client.suggestAddresses('東京都千代田', { sessionToken: 's1' })).toEqual([
      { placeId: 'p1', description: '東京都千代田区丸の内1丁目' },
      { placeId: 'p2', description: '東京都千代田区大手町' },
    ]);
    const call = api.calls[0];
    expect(call?.headers.get('x-goog-api-key')).toBe('test-key');
    expect(call?.url.search).toBe('');
    expect(call?.body).toEqual({
      input: '東京都千代田',
      languageCode: 'ja',
      regionCode: 'jp',
      includedRegionCodes: ['jp'],
      sessionToken: 's1',
    });
  });

  it('suggestAddresses：候補が無いときは空の配列（応答に suggestions が無い）', async () => {
    const { api, client } = setup();
    api.on('POST', AUTOCOMPLETE, () => json({}));
    expect(await client.suggestAddresses('zzzz')).toEqual([]);
  });

  it('getPlace：場所の詳細を返す。無い ID は undefined', async () => {
    const { api, client, calls } = setup();
    api.on(
      'GET',
      PLACE,
      () =>
        json({
          id: 'ChIJ-test',
          displayName: { text: 'スーパー渋谷店' },
          formattedAddress: '東京都渋谷区道玄坂1丁目',
          location: { latitude: 35.658, longitude: 139.7016 },
          currentOpeningHours: { openNow: true },
        }),
      () => status(404),
    );
    expect(await client.getPlace('ChIJ-test')).toEqual({
      placeId: 'ChIJ-test',
      name: 'スーパー渋谷店',
      address: '東京都渋谷区道玄坂1丁目',
      location: SHIBUYA,
      openNow: true,
    });
    expect(api.calls[0]?.headers.get('x-goog-fieldmask')).toContain('currentOpeningHours');
    expect(await client.getPlace('ChIJ-test')).toBeUndefined();
    expect(calls.map((c) => c.outcome)).toEqual(['success', 'client_error']);
  });

  it('searchPlaces：近くの店舗を探す（営業時間の情報が無い店は openNow が undefined）', async () => {
    const { api, client } = setup();
    api.on('POST', SEARCH_TEXT, () =>
      json({
        places: [
          {
            id: 'p1',
            displayName: { text: 'スーパーA' },
            formattedAddress: '東京都渋谷区1',
            location: { latitude: 35.66, longitude: 139.7 },
            currentOpeningHours: { openNow: false },
          },
          { id: 'p2', displayName: { text: 'スーパーB' } },
        ],
      }),
    );
    const places = await client.searchPlaces({
      query: 'スーパー',
      near: SHIBUYA,
      radiusMeters: 800,
      maxResults: 50,
      openNow: true,
    });
    expect(places).toEqual([
      {
        placeId: 'p1',
        name: 'スーパーA',
        address: '東京都渋谷区1',
        location: { lat: 35.66, lng: 139.7 },
        openNow: false,
      },
      {
        placeId: 'p2',
        name: 'スーパーB',
        address: undefined,
        location: undefined,
        openNow: undefined,
      },
    ]);
    expect(api.calls[0]?.body).toEqual({
      textQuery: 'スーパー',
      languageCode: 'ja',
      regionCode: 'jp',
      maxResultCount: 20,
      openNow: true,
      locationBias: { circle: { center: { latitude: 35.658, longitude: 139.7016 }, radius: 800 } },
    });
    expect(api.calls[0]?.headers.get('x-goog-fieldmask')).toContain('places.id');
  });

  it('searchPlaces：0件は空の配列', async () => {
    const { api, client } = setup();
    api.on('POST', SEARCH_TEXT, () => json({}));
    expect(await client.searchPlaces({ query: 'スーパー' })).toEqual([]);
  });

  it('computeRoute：距離・所要時間・線の形を返す', async () => {
    const { api, client } = setup();
    api.on('POST', ROUTES, () =>
      json({
        routes: [
          { distanceMeters: 1234, duration: '987s', polyline: { encodedPolyline: 'abc123' } },
        ],
      }),
    );
    expect(
      await client.computeRoute({ origin: TOKYO, destination: SHIBUYA, mode: 'walk' }),
    ).toEqual({ distanceMeters: 1234, durationSeconds: 987, polyline: 'abc123' });
    expect(api.calls[0]?.body).toEqual({
      origin: { location: { latLng: { latitude: 35.6812, longitude: 139.7671 } } },
      destination: { location: { latLng: { latitude: 35.658, longitude: 139.7016 } } },
      travelMode: 'WALK',
      languageCode: 'ja',
      regionCode: 'jp',
      units: 'METRIC',
    });
  });

  it('computeRoute：車で出発時刻を指定すると渋滞を考慮する。自転車・徒歩では指定しない', async () => {
    const { api, client } = setup();
    api.on('POST', ROUTES, () => json({ routes: [{ distanceMeters: 1, duration: '1s' }] }));
    const departureTime = new Date('2026-11-11T09:00:00+09:00');
    const route = { origin: TOKYO, destination: SHIBUYA, departureTime };
    await client.computeRoute({ ...route, mode: 'car' });
    await client.computeRoute({ ...route, mode: 'bicycle' });
    expect(api.calls[0]?.body).toMatchObject({
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: '2026-11-11T00:00:00.000Z',
    });
    expect(api.calls[1]?.body).toMatchObject({ travelMode: 'BICYCLE' });
    expect(api.calls[1]?.body).not.toHaveProperty('departureTime');
  });

  it('computeRoute：経路が無ければ undefined', async () => {
    const { api, client } = setup();
    api.on('POST', ROUTES, () => json({}));
    expect(
      await client.computeRoute({ origin: TOKYO, destination: SHIBUYA, mode: 'walk' }),
    ).toBeUndefined();
  });
});

describe.each(OPERATIONS)('Google Maps クライアント：%s の失敗', (operation, method, url, call) => {
  it('タイムアウト：やり直してもだめなら timeout エラー（2回と数える）', async () => {
    const { api, client, calls } = setup();
    api.on(method, url, hang);
    await expect(call(client)).rejects.toMatchObject({
      name: 'ExternalApiError',
      service: 'google_maps',
      operation,
      kind: 'timeout',
    });
    expect(calls.map((c) => [c.operation, c.outcome])).toEqual([
      [operation, 'timeout'],
      [operation, 'timeout'],
    ]);
  });

  it('5xx：やり直してもだめなら http エラー（2回と数える）', async () => {
    const { api, client, calls } = setup();
    api.on(method, url, () => status(503));
    await expect(call(client)).rejects.toMatchObject({ operation, kind: 'http', status: 503 });
    expect(calls.map((c) => c.outcome)).toEqual(['server_error', 'server_error']);
  });
});
