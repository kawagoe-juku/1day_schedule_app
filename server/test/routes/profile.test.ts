import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalApiError } from '../../src/adapters/http.js';
import type { GoogleMapsClient } from '../../src/adapters/google-maps.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import {
  AUTH,
  TEST_EMAIL,
  TEST_USER_ID,
  fakeCognito,
  fakeVerifier,
  memoryProfileStore,
} from '../helpers/route-app.js';

const config = loadConfig({ NODE_ENV: 'test' });
const TOKYO_STATION = { lat: 35.681236, lng: 139.767125 };

type Maps = Pick<GoogleMapsClient, 'geocode' | 'getPlace'>;
/** 候補の ID「place-tokyo」と住所「東京都千代田区丸の内1丁目」だけを知っている Google Maps */
function fakeMaps(overrides: Partial<Maps> = {}) {
  const calls: string[] = [];
  const maps: Maps = {
    async getPlace(placeId) {
      calls.push(`getPlace:${placeId}`);
      return placeId === 'place-tokyo'
        ? { placeId, name: '東京駅', location: TOKYO_STATION }
        : undefined;
    },
    async geocode(address) {
      calls.push(`geocode:${address}`);
      return address === '東京都千代田区丸の内1丁目'
        ? { placeId: 'place-tokyo', formattedAddress: address, location: TOKYO_STATION }
        : undefined;
    },
    ...overrides,
  };
  return { maps, calls };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(options: { maps?: Maps | null; configured?: boolean } = {}) {
  const profiles = memoryProfileStore();
  const cognito = fakeCognito();
  const google = fakeMaps();
  const configured = options.configured ?? true;
  app = await buildApp({
    config,
    verifier: fakeVerifier,
    users: configured ? profiles.store : undefined,
    cognito: cognito.client,
    external: {
      googleMaps:
        options.maps === null ? undefined : ((options.maps ?? google.maps) as GoogleMapsClient),
    },
    logger: false,
  });
  const get = () => app!.inject({ method: 'GET', url: '/api/profile', headers: AUTH });
  const put = (payload: unknown) =>
    app!.inject({ method: 'PUT', url: '/api/profile', headers: AUTH, payload: payload as object });
  return { profiles, cognito, google, get, put };
}

const ONBOARDING = {
  homeAddress: '東京都千代田区丸の内1丁目',
  homePlaceId: 'place-tokyo',
  acceptTerms: true,
  completeOnboarding: true,
};

describe('GET /api/profile', () => {
  it('初回は既定値のプロファイルを返す（メールアドレスは Cognito から取得）', async () => {
    const { get, cognito } = await setup();
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: TEST_EMAIL,
      onboardingCompleted: false,
      homeAddress: null,
      homeLocation: null,
      frequentStations: [],
      walkingSpeed: 'normal',
      preparationTimeMinutes: 30,
      priorityCondition: 'on_time',
      termsAcceptedAt: null,
    });
    expect(cognito.calls).toEqual([{ userId: TEST_USER_ID, accessToken: `token-${TEST_USER_ID}` }]);
  });

  it('トークンがなければ 401', async () => {
    await setup();
    const res = await app!.inject({ method: 'GET', url: '/api/profile' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('ほかの利用者のプロファイルは見えない（トークンの利用者のものだけを返す）', async () => {
    const { put } = await setup();
    await put({ walkingSpeed: 'fast' });
    const other = await app!.inject({
      method: 'GET',
      url: '/api/profile',
      headers: { authorization: 'Bearer token-other-user' },
    });
    expect(other.json().walkingSpeed).toBe('normal');
  });

  it('DB が未設定なら 500（中身は返さない）', async () => {
    const { get } = await setup({ configured: false });
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });
});

describe('PUT /api/profile', () => {
  it('指定した項目だけを更新する', async () => {
    const { put, get } = await setup();
    const res = await put({ walkingSpeed: 'slow', preparationTimeMinutes: 45 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      walkingSpeed: 'slow',
      preparationTimeMinutes: 45,
      priorityCondition: 'on_time',
      onboardingCompleted: false,
    });
    expect((await get()).json()).toMatchObject({
      walkingSpeed: 'slow',
      preparationTimeMinutes: 45,
    });
  });

  it('空の本文では何も変えず、現在のプロファイルを返す', async () => {
    const { put } = await setup();
    const res = await put({});
    expect(res.statusCode).toBe(200);
    expect(res.json().walkingSpeed).toBe('normal');
  });

  it('候補から選んだ住所は、候補の ID から緯度・経度を求めて保存する', async () => {
    const { put, google, profiles } = await setup();
    const res = await put({ homeAddress: '東京都千代田区丸の内1丁目', homePlaceId: 'place-tokyo' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      homeAddress: '東京都千代田区丸の内1丁目',
      homeLocation: TOKYO_STATION,
    });
    expect(google.calls).toEqual(['getPlace:place-tokyo']);
    expect(profiles.rows.get(TEST_USER_ID)).toMatchObject({
      homeLatitude: TOKYO_STATION.lat,
      homeLongitude: TOKYO_STATION.lng,
    });
  });

  it('住所だけを指定したときは、住所の文字列から緯度・経度を求める', async () => {
    const { put, google } = await setup();
    const res = await put({ homeAddress: ' 東京都千代田区丸の内1丁目 ' });
    expect(res.json().homeLocation).toEqual(TOKYO_STATION);
    expect(res.json().homeAddress).toBe('東京都千代田区丸の内1丁目');
    expect(google.calls).toEqual(['geocode:東京都千代田区丸の内1丁目']);
  });

  it('住所を変えない更新では Google Maps を呼ばない', async () => {
    const { put, google } = await setup();
    await put({ priorityCondition: 'points' });
    expect(google.calls).toEqual([]);
  });

  it.each([
    ['候補の ID が見つからない', { homeAddress: 'どこか', homePlaceId: 'unknown' }, 'homePlaceId'],
    ['住所が見つからない', { homeAddress: 'どこにもない住所' }, 'homeAddress'],
    ['候補の ID だけで住所がない', { homePlaceId: 'place-tokyo' }, 'homeAddress'],
  ])('%s ときは 400 で、住所は保存しない', async (_name, payload, field) => {
    const { put, profiles } = await setup();
    const res = await put(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.details.map((d: { field: string }) => d.field)).toEqual([field]);
    expect(profiles.rows.get(TEST_USER_ID)?.homeAddress ?? null).toBeNull();
  });

  it('Google Maps が失敗したら 502 で、何も保存しない', async () => {
    const failing = fakeMaps({
      async getPlace() {
        throw new ExternalApiError('google_maps', 'place_details', 'timeout');
      },
    });
    const { put, profiles } = await setup({ maps: failing.maps });
    const res = await put({ ...ONBOARDING, walkingSpeed: 'fast' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('EXTERNAL_SERVICE_ERROR');
    expect(profiles.rows.get(TEST_USER_ID)).toMatchObject({
      walkingSpeed: 'normal',
      onboardingCompleted: false,
    });
  });

  it('Google Maps のキーが未設定なら、住所の更新は 502（住所以外は更新できる）', async () => {
    const { put } = await setup({ maps: null });
    expect((await put({ homeAddress: '東京都千代田区丸の内1丁目' })).statusCode).toBe(502);
    expect((await put({ walkingSpeed: 'fast' })).statusCode).toBe(200);
  });

  it('よく使う駅を保存する（駅コード・ラベルは省略できる）', async () => {
    const { put } = await setup();
    const frequentStations = [
      { stationCode: '00007820', stationName: '吉祥寺', label: '自宅' },
      { stationName: '渋谷' },
    ];
    const res = await put({ frequentStations });
    expect(res.statusCode).toBe(200);
    expect(res.json().frequentStations).toEqual(frequentStations);
  });

  describe('オンボーディングの完了', () => {
    it('住所・候補の ID・同意がそろっていれば完了にし、同意の日時を記録する', async () => {
      const { put } = await setup();
      const res = await put(ONBOARDING);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ onboardingCompleted: true, homeLocation: TOKYO_STATION });
      expect(res.json().termsAcceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
    });

    it('足りない項目があれば 400 で、項目ごとに理由を返す', async () => {
      const { put, profiles } = await setup();
      const res = await put({ completeOnboarding: true, acceptTerms: false });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details).toEqual([
        { field: 'homeAddress', message: '自宅住所を入力してください' },
        { field: 'homePlaceId', message: '自宅住所は候補から選んでください' },
        { field: 'acceptTerms', message: '利用への同意が必要です' },
      ]);
      expect(profiles.rows.size).toBe(0);
    });

    it('完了と同意は、あとから取り消せない（同意の日時も変わらない）', async () => {
      const { put } = await setup();
      const first = (await put(ONBOARDING)).json();
      const res = await put({ completeOnboarding: false, acceptTerms: false });
      expect(res.json()).toMatchObject({
        onboardingCompleted: true,
        termsAcceptedAt: first.termsAcceptedAt,
      });
      const again = await put({ acceptTerms: true });
      expect(again.json().termsAcceptedAt).toBe(first.termsAcceptedAt);
    });
  });

  describe('入力チェック', () => {
    it.each([
      ['知らない項目', { email: 'new@example.com' }, ''],
      ['徒歩速度が列挙値でない', { walkingSpeed: 'run' }, 'walkingSpeed'],
      ['準備時間が上限を超える', { preparationTimeMinutes: 181 }, 'preparationTimeMinutes'],
      ['準備時間が文字列', { preparationTimeMinutes: '30' }, 'preparationTimeMinutes'],
      ['住所が空', { homeAddress: '  ' }, 'homeAddress'],
      ['住所が長すぎる', { homeAddress: 'あ'.repeat(256) }, 'homeAddress'],
      [
        '駅が21件',
        { frequentStations: Array.from({ length: 21 }, () => ({ stationName: '渋谷' })) },
        'frequentStations',
      ],
      ['駅名がない', { frequentStations: [{ label: '自宅' }] }, 'frequentStations.0.stationName'],
    ])('%s ときは 400', async (_name, payload, field) => {
      const { put, google } = await setup();
      const res = await put(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.json().error.details[0].field).toBe(field);
      expect(res.json().error.details[0].message).toMatch(/[ぁ-ん]/); // 日本語のメッセージ
      expect(google.calls).toEqual([]);
    });

    it('本文が JSON でなければ 400', async () => {
      await setup();
      const res = await app!.inject({
        method: 'PUT',
        url: '/api/profile',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: '{',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
