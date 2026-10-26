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
  it('DB未設定ならdb=skippedで200', async () => {
    app = await buildApp({ config, logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'skipped' } });
  });

  it('DBに接続できれば200', async () => {
    app = await buildApp({ config, db: fakeDb(true), logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { db: 'ok' } });
  });

  it('DBに接続できなければ503', async () => {
    app = await buildApp({ config, db: fakeDb(false), logger: false });
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'ng', checks: { db: 'ng' } });
  });
});
