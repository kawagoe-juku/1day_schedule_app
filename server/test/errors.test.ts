import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';

const config = loadConfig({ NODE_ENV: 'test' });

let app: FastifyInstance | undefined;
const start = async () => (app = await buildApp({ config, logger: false }));
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('共通エラー形式', () => {
  it('存在しないパスは404 NOT_FOUND', async () => {
    const app = await start();
    const res = await app.inject({
      method: 'GET',
      url: '/api/unknown',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: '対象が見つかりません', requestId: 'req-123' },
    });
  });

  it('AppErrorはステータスとコードをそのまま返す', async () => {
    const app = await start();
    app.get('/api/test-rate', async () => {
      throw new AppError(429, 'RATE_LIMITED', '本日の生成回数の上限に達しました');
    });
    const res = await app.inject({ method: 'GET', url: '/api/test-rate' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  it('入力検証エラーは400 VALIDATION_ERRORと項目名（先頭スラッシュなし）を返す', async () => {
    const app = await start();
    app.post(
      '/api/test-validate',
      {
        schema: {
          body: {
            type: 'object',
            required: ['inputText'],
            properties: { inputText: { type: 'string', maxLength: 5 } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    // 必須項目の欠落と桁数超過のどちらも、field は項目名になる
    for (const payload of [{}, { inputText: '123456' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/test-validate', payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(res.json().error.details[0].field).toBe('inputText');
    }
  });

  it('不正なJSONは500ではなく400 VALIDATION_ERROR', async () => {
    const app = await start();
    app.post('/api/test-json', async () => ({ ok: true }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/test-json',
      headers: { 'content-type': 'application/json' },
      payload: '{"inputText":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('形式が不正なx-request-idは採用せず新しいIDを振る', async () => {
    const app = await start();
    const bad = 'x'.repeat(200);
    const res = await app.inject({
      method: 'GET',
      url: '/api/unknown',
      headers: { 'x-request-id': bad },
    });
    expect(res.json().error.requestId).not.toBe(bad);
    expect(res.headers['x-request-id']).toBe(res.json().error.requestId);
  });

  it('想定外の例外は500 INTERNAL_ERRORで内部情報を返さない', async () => {
    const app = await start();
    app.get('/api/test-crash', async () => {
      throw new Error('secret internal detail');
    });
    const res = await app.inject({ method: 'GET', url: '/api/test-crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.body).not.toContain('secret internal detail');
  });
});
