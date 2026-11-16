import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CognitoTokenRejectedError } from '../../src/adapters/cognito.js';
import { ExternalApiError } from '../../src/adapters/http.js';
import type { GoogleMapsClient } from '../../src/adapters/google-maps.js';
import { buildApp, loggerOptions } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { ProfileStore } from '../../src/routes/profile.js';
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

interface SetupOptions {
  /** null なら Google Maps のキーが未設定の状態にする */
  maps?: Maps | null;
  /** false なら DB が未設定の状態にする */
  configured?: boolean;
  /** false なら Cognito が未設定の状態にする */
  cognitoConfigured?: boolean;
  /** 保存先を差し替える（失敗させるときなど） */
  store?: (store: ProfileStore) => ProfileStore;
}

async function setup(options: SetupOptions = {}) {
  const profiles = memoryProfileStore();
  const cognito = fakeCognito();
  const google = fakeMaps();
  const store = options.store ? options.store(profiles.store) : profiles.store;
  // ログの中身を確かめられるよう、出力を集める
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  app = await buildApp({
    config,
    verifier: fakeVerifier,
    users: (options.configured ?? true) ? store : undefined,
    cognito: (options.cognitoConfigured ?? true) ? cognito.client : undefined,
    external: {
      googleMaps:
        options.maps === null ? undefined : ((options.maps ?? google.maps) as GoogleMapsClient),
    },
    logger: { ...loggerOptions('info'), stream },
  });
  const get = () => app!.inject({ method: 'GET', url: '/api/profile', headers: AUTH });
  const put = (payload: unknown) =>
    app!.inject({ method: 'PUT', url: '/api/profile', headers: AUTH, payload: payload as object });
  return { profiles, cognito, google, get, put, logs: () => logs.join('') };
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

describe('Cognito・DB の失敗', () => {
  it('Cognito がトークンを受け付けなければ（失効）、取得も更新も 401', async () => {
    const { get, put, cognito, profiles } = await setup();
    cognito.state.failWith = new CognitoTokenRejectedError();
    for (const res of [await get(), await put({ walkingSpeed: 'fast' })]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
    expect(profiles.rows.get(TEST_USER_ID)?.walkingSpeed ?? 'normal').toBe('normal');
  });

  it('Cognito に接続できなければ 502（何も保存しない）', async () => {
    const { get, put, cognito, profiles } = await setup();
    cognito.state.failWith = new ExternalApiError('cognito', 'get_user', 'timeout');
    expect((await get()).statusCode).toBe(502);
    expect((await put({ walkingSpeed: 'fast' })).statusCode).toBe(502);
    expect(profiles.rows.get(TEST_USER_ID)?.walkingSpeed ?? 'normal').toBe('normal');
  });

  it('Cognito が未設定なら 500', async () => {
    const { get } = await setup({ cognitoConfigured: false });
    expect((await get()).statusCode).toBe(500);
  });

  it('DB の更新が失敗しても、住所・座標・駅名をログにも応答にも出さない', async () => {
    // Drizzle の例外は、メッセージに SQL へ渡した値を含む
    class DrizzleQueryError extends Error {
      constructor(
        readonly query: string,
        readonly params: unknown[],
        cause: Error,
      ) {
        super(`Failed query: ${query}\nparams: ${params.join(',')}`, { cause });
        this.name = 'DrizzleQueryError';
      }
    }
    const { put, logs } = await setup({
      store: (store) => ({
        ensure: store.ensure,
        async update(_id, values) {
          throw new DrizzleQueryError(
            'update "user" set "home_address" = $1 where "id" = $2',
            [
              values.homeAddress,
              values.homeLatitude,
              JSON.stringify(values.frequentlyUsedStations),
            ],
            Object.assign(new Error('connection terminated: 秘密ハイツ'), { code: '08006' }),
          );
        },
      }),
    });
    const res = await put({
      homeAddress: '東京都千代田区丸の内1丁目 秘密ハイツ101',
      homePlaceId: 'place-tokyo',
      frequentStations: [{ stationName: '吉祥寺' }],
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('秘密ハイツ');

    const output = logs();
    expect(output).toContain('unhandled error');
    expect(output).toContain('update \\"user\\"'); // SQL の文は残る
    expect(output).toContain('08006'); // PostgreSQL のエラーコードも残る
    for (const secret of ['秘密ハイツ', '35.681236', '139.767125', '吉祥寺']) {
      expect(output).not.toContain(secret);
    }
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

  it('候補の場所に座標がなければ 400 で、住所は保存しない', async () => {
    const noLocation = fakeMaps({
      async getPlace(placeId) {
        return { placeId, name: '座標のない場所' };
      },
    });
    const { put, profiles } = await setup({ maps: noLocation.maps });
    const res = await put({ homeAddress: 'どこか', homePlaceId: 'place-x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].field).toBe('homePlaceId');
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
    const REQUIRED = '必須の項目です';
    const WRONG_TYPE = '値の形式が正しくありません';
    it.each([
      ['知らない項目', { email: 'new@example.com' }, '', '指定できない項目です：email'],
      ['徒歩速度が列挙値でない', { walkingSpeed: 'run' }, 'walkingSpeed', '値が正しくありません'],
      [
        '準備時間が上限を超える',
        { preparationTimeMinutes: 181 },
        'preparationTimeMinutes',
        '180以下の値を指定してください',
      ],
      ['準備時間が文字列', { preparationTimeMinutes: '30' }, 'preparationTimeMinutes', WRONG_TYPE],
      ['準備時間が小数', { preparationTimeMinutes: 1.5 }, 'preparationTimeMinutes', WRONG_TYPE],
      ['住所が null', { homeAddress: null }, 'homeAddress', WRONG_TYPE],
      ['住所が空', { homeAddress: '  ' }, 'homeAddress', '1文字以上で入力してください'],
      [
        '住所が長すぎる',
        { homeAddress: 'あ'.repeat(256) },
        'homeAddress',
        '255文字以内で入力してください',
      ],
      [
        '住所に制御文字（NUL）がある',
        { homeAddress: '東京都\u0000千代田区' },
        'homeAddress',
        '使用できない文字が含まれています',
      ],
      [
        '駅が21件',
        { frequentStations: Array.from({ length: 21 }, () => ({ stationName: '渋谷' })) },
        'frequentStations',
        '20件以内で指定してください',
      ],
      [
        '駅名がない',
        { frequentStations: [{ label: '自宅' }] },
        'frequentStations.0.stationName',
        REQUIRED,
      ],
      [
        '駅名が空白だけ',
        { frequentStations: [{ stationName: '   ' }] },
        'frequentStations.0.stationName',
        '1文字以上で入力してください',
      ],
      [
        '駅のラベルが空',
        { frequentStations: [{ stationName: '渋谷', label: '' }] },
        'frequentStations.0.label',
        '1文字以上で入力してください',
      ],
    ])('%s ときは 400', async (_name, payload, field, message) => {
      const { put, google, profiles } = await setup();
      const res = await put(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.json().error.details[0]).toEqual({ field, message });
      expect(google.calls).toEqual([]);
      expect(profiles.rows.size).toBe(0);
    });

    it('本文が配列なら 400（型が違う）', async () => {
      const { put } = await setup();
      const res = await put([]);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details[0]).toEqual({ field: '', message: WRONG_TYPE });
    });

    it('駅名・ラベルの前後の空白は取り除いて保存する', async () => {
      const { put } = await setup();
      const res = await put({ frequentStations: [{ stationName: ' 渋谷 ', label: ' 勤務先 ' }] });
      expect(res.json().frequentStations).toEqual([{ stationName: '渋谷', label: '勤務先' }]);
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
