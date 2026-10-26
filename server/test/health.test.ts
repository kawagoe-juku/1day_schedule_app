import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { DbChecker } from '../src/db.js';

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
