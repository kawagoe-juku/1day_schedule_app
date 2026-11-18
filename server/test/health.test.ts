import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DbChecker } from '../src/db/client.js';

const config = loadConfig({ NODE_ENV: 'test', APP_VERSION: '9.9.9' });
const fakeDb = (ok: boolean): DbChecker => ({ ping: async () => ok, close: async () => {} });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/health', () => {
  it('稼働中ならstatus=okとバージョンを返す', async () => {
    app = await buildApp({ config, logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: '9.9.9' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('GET /api/health/ready', () => {
  it.each([
    ['DB未設定ならdb=skippedで200', undefined, 200, { status: 'ok', checks: { db: 'skipped' } }],
    ['DBに接続できれば200', fakeDb(true), 200, { status: 'ok', checks: { db: 'ok' } }],
    ['DBに接続できなければ503', fakeDb(false), 503, { status: 'ng', checks: { db: 'ng' } }],
  ])('%s', async (_name, db, statusCode, body) => {
    app = await buildApp({ config, db, logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(statusCode);
    expect(res.json()).toEqual(body);
  });
});

describe('GET /api/config', () => {
  it('認証なしで、ログイン先の Cognito の設定を返す', async () => {
    app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        COGNITO_USER_POOL_ID: 'ap-northeast-1_TestPool1',
        COGNITO_WEB_CLIENT_ID: 'test-web-client',
      }),
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      cognito: {
        region: 'ap-northeast-1',
        userPoolId: 'ap-northeast-1_TestPool1',
        webClientId: 'test-web-client',
      },
    });
  });

  it('Cognito が未設定なら 500', async () => {
    app = await buildApp({ config, logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });
});
