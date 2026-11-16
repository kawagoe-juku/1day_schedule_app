import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalApiError } from '../../src/adapters/http.js';
import type { ExternalClients } from '../../src/adapters/index.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { SUGGEST_RATE_LIMIT, toPrefecture } from '../../src/routes/geo.js';
import { AUTH, fakeVerifier } from '../helpers/route-app.js';

const config = loadConfig({ NODE_ENV: 'test' });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** 候補を返す代用品。calls に受け取った引数が残る */
function fakeClients() {
  const calls: unknown[][] = [];
  const external = {
    googleMaps: {
      async suggestAddresses(input: string) {
        calls.push(['address', input]);
        return Array.from({ length: 7 }, (_, i) => ({
          placeId: `place-${i + 1}`,
          description: `東京都千代田区丸の内${i + 1}丁目`,
        }));
      },
    },
    navitime: {
      async suggestStations(word: string, options?: { limit?: number }) {
        calls.push(['station', word, options]);
        return [
          {
            stationCode: '00006668',
            stationName: '東京',
            ruby: 'とうきょう',
            address: '東京都千代田区丸の内',
          },
          { stationCode: '00009999', stationName: '京都', address: '京都府京都市下京区' },
          { stationCode: '00001111', stationName: '所在地なし' },
        ];
      },
    },
  };
  return { external: external as unknown as ExternalClients, calls };
}

async function setup(external?: ExternalClients) {
  const fake = fakeClients();
  app = await buildApp({
    config,
    verifier: fakeVerifier,
    external: external ?? fake.external,
    logger: false,
  });
  const get = (url: string, headers: Record<string, string> = AUTH) =>
    app!.inject({ method: 'GET', url, headers });
  return { get, calls: fake.calls };
}

const q = encodeURIComponent('東京');

describe('GET /api/geo/address-suggestions', () => {
  it('住所の候補を返す（既定は5件まで）', async () => {
    const { get, calls } = await setup();
    const res = await get(`/api/geo/address-suggestions?q=${q}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(5);
    expect(res.json().items[0]).toEqual({
      placeId: 'place-1',
      description: '東京都千代田区丸の内1丁目',
    });
    expect(calls).toEqual([['address', '東京']]);
  });

  it('limit で件数を変えられる', async () => {
    const { get } = await setup();
    expect((await get(`/api/geo/address-suggestions?q=${q}&limit=2`)).json().items).toHaveLength(2);
  });

  it('空白だけの入力では、外部 API を呼ばずに 0 件を返す', async () => {
    const { get, calls } = await setup();
    const res = await get('/api/geo/address-suggestions?q=%20%20');
    expect(res.json()).toEqual({ items: [] });
    expect(calls).toEqual([]);
  });

  it.each([
    ['q がない', ''],
    ['q が空', '?q='],
    ['q が101文字', `?q=${'a'.repeat(101)}`],
    ['limit が 0', `?q=${q}&limit=0`],
    ['limit が 11', `?q=${q}&limit=11`],
    ['limit が数値でない', `?q=${q}&limit=abc`],
  ])('%s ときは 400', async (_name, query) => {
    const { get, calls } = await setup();
    const res = await get(`/api/geo/address-suggestions${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(calls).toEqual([]);
  });

  it('トークンがなければ 401', async () => {
    const { get } = await setup();
    expect((await get(`/api/geo/address-suggestions?q=${q}`, {})).statusCode).toBe(401);
  });

  it('Google Maps が失敗したら 502', async () => {
    const { get } = await setup({
      googleMaps: {
        async suggestAddresses() {
          throw new ExternalApiError('google_maps', 'places_autocomplete', 'http', 500);
        },
      },
    } as unknown as ExternalClients);
    const res = await get(`/api/geo/address-suggestions?q=${q}`);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('EXTERNAL_SERVICE_ERROR');
  });

  it('キーが未設定なら 502', async () => {
    const { get } = await setup({});
    expect((await get(`/api/geo/address-suggestions?q=${q}`)).statusCode).toBe(502);
  });
});

describe('GET /api/geo/station-suggestions', () => {
  it('駅名の候補を返す（都道府県は所在地の先頭から取り出す）', async () => {
    const { get, calls } = await setup();
    const res = await get(`/api/geo/station-suggestions?q=${q}&limit=3`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { stationCode: '00006668', stationName: '東京', prefecture: '東京都' },
        { stationCode: '00009999', stationName: '京都', prefecture: '京都府' },
        { stationCode: '00001111', stationName: '所在地なし' },
      ],
    });
    expect(calls).toEqual([['station', '東京', { limit: 3 }]]);
  });

  it('limit を省略すると 5 件までを求める', async () => {
    const { get, calls } = await setup();
    await get(`/api/geo/station-suggestions?q=${q}`);
    expect(calls).toEqual([['station', '東京', { limit: 5 }]]);
  });

  it('q がなければ 400、トークンがなければ 401、キーが未設定なら 502', async () => {
    const { get } = await setup();
    expect((await get('/api/geo/station-suggestions')).statusCode).toBe(400);
    expect((await get(`/api/geo/station-suggestions?q=${q}`, {})).statusCode).toBe(401);
    await app!.close();
    const unconfigured = await setup({});
    expect((await unconfigured.get(`/api/geo/station-suggestions?q=${q}`)).statusCode).toBe(502);
  });
});

describe('候補の API の回数制限', () => {
  it('利用者ごとに、住所と駅名の合計が上限を超えたら 429（Retry-After 付き）で、外部 API を呼ばない', async () => {
    const { get, calls } = await setup();
    for (let i = 0; i < SUGGEST_RATE_LIMIT.limit; i += 1) {
      const path = i % 2 === 0 ? 'address-suggestions' : 'station-suggestions';
      expect((await get(`/api/geo/${path}?q=${q}`)).statusCode).toBe(200);
    }
    const res = await get(`/api/geo/address-suggestions?q=${q}`);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls).toHaveLength(SUGGEST_RATE_LIMIT.limit);

    // ほかの利用者は影響を受けない
    const other = await get(`/api/geo/station-suggestions?q=${q}`, {
      authorization: 'Bearer token-other-user',
    });
    expect(other.statusCode).toBe(200);
  });
});

describe('toPrefecture', () => {
  it.each([
    ['東京都千代田区丸の内', '東京都'],
    ['北海道札幌市北区', '北海道'],
    ['大阪府大阪市北区', '大阪府'],
    ['京都府京都市下京区', '京都府'],
    ['神奈川県横浜市西区', '神奈川県'],
    ['千葉県千葉市中央区', '千葉県'],
  ])('%s → %s', (address, expected) => {
    expect(toPrefecture(address)).toBe(expected);
  });

  it('取り出せないときは undefined', () => {
    expect(toPrefecture(undefined)).toBeUndefined();
    expect(toPrefecture('Tokyo')).toBeUndefined();
  });
});
