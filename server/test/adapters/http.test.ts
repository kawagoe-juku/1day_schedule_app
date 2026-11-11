import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExternalApiError, requestJson, type HttpOptions } from '../../src/adapters/http.js';
import { createEmfMetrics, type ExternalApiCall } from '../../src/adapters/metrics.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createFakeFetch, hang, json, networkError, status } from '../helpers/fake-fetch.js';

const URL_ITEMS = 'https://api.example.com/v1/items';
const schema = z.object({ items: z.array(z.string()) });
const request = {
  service: 'example',
  operation: 'list_items',
  url: `${URL_ITEMS}?key=SECRET-KEY`,
  schema,
};

/** 待ち時間なしで動かし、メトリクスと待った時間を記録する */
function harness(overrides: HttpOptions = {}) {
  const api = createFakeFetch();
  const calls: ExternalApiCall[] = [];
  const slept: number[] = [];
  const options: HttpOptions = {
    fetch: api.fetch,
    metrics: { record: (c) => calls.push(c) },
    sleep: async (ms) => void slept.push(ms),
    ...overrides,
  };
  return { api, calls, slept, options, outcomes: () => calls.map((c) => c.outcome) };
}

describe('requestJson', () => {
  it('正常：JSON を返し、呼び出しを1回数える', async () => {
    const h = harness();
    h.api.on('GET', URL_ITEMS, () => json({ items: ['a'] }));
    expect(await requestJson(request, h.options)).toEqual({ items: ['a'] });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      service: 'example',
      operation: 'list_items',
      outcome: 'success',
    });
    expect(h.calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('POST は本文を JSON で送る', async () => {
    const h = harness();
    h.api.on('POST', URL_ITEMS, () => json({ items: [] }));
    await requestJson(
      { ...request, method: 'POST', body: { q: '牛乳' }, headers: { 'x-api-key': 'k' } },
      h.options,
    );
    expect(h.api.calls[0]?.body).toEqual({ q: '牛乳' });
    expect(h.api.calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(h.api.calls[0]?.headers.get('x-api-key')).toBe('k');
  });

  it('5xx：1回やり直して成功すれば結果を返す（呼び出しは2回と数える）', async () => {
    const h = harness();
    h.api.on(
      'GET',
      URL_ITEMS,
      () => status(503),
      () => json({ items: ['a'] }),
    );
    expect(await requestJson(request, h.options)).toEqual({ items: ['a'] });
    expect(h.outcomes()).toEqual(['server_error', 'success']);
    expect(h.slept).toEqual([200]);
  });

  it('5xx：やり直しても失敗なら http エラー（やり直しは既定で1回）', async () => {
    const h = harness();
    h.api.on('GET', URL_ITEMS, () => status(500));
    await expect(requestJson(request, h.options)).rejects.toMatchObject({
      name: 'ExternalApiError',
      kind: 'http',
      status: 500,
    });
    expect(h.outcomes()).toEqual(['server_error', 'server_error']);
  });

  it('やり直す回数と待ち時間は設定でき、待ち時間は倍に延びる', async () => {
    const h = harness({ retries: 3, retryDelayMs: 100 });
    h.api.on('GET', URL_ITEMS, () => status(502));
    await expect(requestJson(request, h.options)).rejects.toThrow(ExternalApiError);
    expect(h.calls).toHaveLength(4);
    expect(h.slept).toEqual([100, 200, 400]);
  });

  it('4xx：やり直さずに失敗する', async () => {
    const h = harness();
    h.api.on('GET', URL_ITEMS, () => status(403));
    await expect(requestJson(request, h.options)).rejects.toMatchObject({
      kind: 'http',
      status: 403,
    });
    expect(h.outcomes()).toEqual(['client_error']);
    expect(h.slept).toEqual([]);
  });

  it('429（回数制限）はやり直す', async () => {
    const h = harness();
    h.api.on(
      'GET',
      URL_ITEMS,
      () => status(429),
      () => json({ items: [] }),
    );
    await requestJson(request, h.options);
    expect(h.outcomes()).toEqual(['client_error', 'success']);
  });

  it('タイムアウト：打ち切ってやり直し、だめなら timeout エラー', async () => {
    const h = harness({ timeoutMs: 20 });
    h.api.on('GET', URL_ITEMS, hang);
    await expect(requestJson(request, h.options)).rejects.toMatchObject({ kind: 'timeout' });
    expect(h.outcomes()).toEqual(['timeout', 'timeout']);
  });

  it('タイムアウトの後に応答があれば成功する', async () => {
    const h = harness({ timeoutMs: 20 });
    h.api.on('GET', URL_ITEMS, hang, () => json({ items: ['a'] }));
    expect(await requestJson(request, h.options)).toEqual({ items: ['a'] });
    expect(h.outcomes()).toEqual(['timeout', 'success']);
  });

  it('通信エラー：やり直して、だめなら network エラー', async () => {
    const h = harness();
    h.api.on('GET', URL_ITEMS, networkError);
    await expect(requestJson(request, h.options)).rejects.toMatchObject({ kind: 'network' });
    expect(h.outcomes()).toEqual(['network_error', 'network_error']);
  });

  it('応答の形が違えば invalid_response（やり直さない）', async () => {
    const h = harness();
    h.api.on('GET', URL_ITEMS, () => json({ items: 'not-array' }));
    await expect(requestJson(request, h.options)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('JSON でない応答は invalid_response', async () => {
    const h = harness();
    h.api.on('GET', URL_ITEMS, () => new Response('<html>', { status: 200 }));
    await expect(requestJson(request, h.options)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('エラーに URL（API キー）や応答の中身を含めない', async () => {
    const h = harness();
    h.api.on('GET', URL_ITEMS, () => json({ items: [{ address: '東京都千代田区' }] }));
    const error = await requestJson(request, h.options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalApiError);
    const text = `${String(error)} ${JSON.stringify(error)}`;
    expect(text).not.toContain('SECRET-KEY');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('東京都');
  });
});

describe('createEmfMetrics', () => {
  it('呼び出し1回を、CloudWatch が取り込める EMF の1行で出す', () => {
    const lines: string[] = [];
    const metrics = createEmfMetrics({
      stage: 'dev',
      write: (l) => lines.push(l),
      now: () => 1_794_300_000_000,
    });
    metrics.record({
      service: 'navitime',
      operation: 'route_transit',
      outcome: 'success',
      durationMs: 412.6,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      _aws: {
        Timestamp: 1_794_300_000_000,
        CloudWatchMetrics: [
          {
            Namespace: 'ScheduleApp/ExternalApi',
            Dimensions: [
              ['Stage', 'Service'],
              ['Stage', 'Service', 'Operation', 'Outcome'],
            ],
            Metrics: [
              { Name: 'CallCount', Unit: 'Count' },
              { Name: 'DurationMs', Unit: 'Milliseconds' },
            ],
          },
        ],
      },
      Stage: 'dev',
      Service: 'navitime',
      Operation: 'route_transit',
      Outcome: 'success',
      CallCount: 1,
      DurationMs: 413,
    });
  });
});

describe('外部 API の失敗を API の応答にする', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('ExternalApiError は 502 EXTERNAL_SERVICE_ERROR になり、詳細は返さない', async () => {
    app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }),
      logger: false,
      verifier: { verify: async () => ({ sub: 'user-1', exp: 0 }) },
    });
    app.get('/api/test-external', async () => {
      throw new ExternalApiError('navitime', 'route_transit', 'timeout');
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/test-external',
      headers: { authorization: 'Bearer token' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('EXTERNAL_SERVICE_ERROR');
    expect(res.body).not.toContain('navitime');
  });
});
