import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, loggerOptions } from '../src/app.js';
import { createCognitoVerifier, type TokenVerifier } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { toJstIso } from '../src/routes/session.js';

// テスト用の User Pool。公開鍵はキャッシュに入れ、Cognito には接続しない
const POOL_ID = 'ap-northeast-1_TestPool1';
const CLIENT_ID = 'test-web-client';
const ISSUER = `https://cognito-idp.ap-northeast-1.amazonaws.com/${POOL_ID}`;
const KID = 'test-key';

const config = loadConfig({ NODE_ENV: 'test' });
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64url = (v: object | Buffer) =>
  (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

/** RS256 の JWT を作る（Cognito のアクセストークンと同じ項目） */
function sign(claims: Record<string, unknown> = {}, key: KeyObject = keys.privateKey): string {
  const payload = {
    sub: 'user-123',
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: 'access',
    iat: now(),
    exp: now() + 3600,
    ...claims,
  };
  const data = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url(payload)}`;
  const signature = createSign('RSA-SHA256').update(data).sign(key);
  return `${data}.${b64url(signature)}`;
}

let verifier: TokenVerifier;
beforeAll(() => {
  const jwk = keys.publicKey.export({ format: 'jwk' });
  verifier = createCognitoVerifier(POOL_ID, CLIENT_ID, {
    keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }],
  } as Parameters<typeof createCognitoVerifier>[2]);
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const getSession = async (authorization?: string) => {
  app = await buildApp({ config, verifier, logger: false });
  return app.inject({
    method: 'GET',
    url: '/api/session',
    headers: authorization ? { authorization } : {},
  });
};

describe('JWT の検証', () => {
  it('正しいアクセストークンなら 200 で、利用者と有効期限（日本時間）を返す', async () => {
    const exp = now() + 3600;
    const res = await getSession(`Bearer ${sign({ exp })}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: 'user-123', expiresAt: toJstIso(exp) });
  });

  it.each([
    ['トークンなし', undefined],
    ['Bearer 以外の形式', `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['形式が不正', 'Bearer not-a-jwt'],
    ['期限切れ', `Bearer ${sign({ exp: now() - 60 })}`],
    ['別の鍵で署名', `Bearer ${sign({}, otherKeys.privateKey)}`],
    ['別のクライアント', `Bearer ${sign({ client_id: 'other-client' })}`],
    ['別の User Pool', `Bearer ${sign({ iss: `${ISSUER}x` })}`],
    ['ID トークン', `Bearer ${sign({ token_use: 'id' })}`],
  ])('%s は 401 UNAUTHORIZED', async (_name, authorization) => {
    const res = await getSession(authorization);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('検証先が設定されていなければ、認証が必要な API はすべて 401', async () => {
    app = await buildApp({ config, logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { authorization: `Bearer ${sign()}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('HEAD でも認証を迂回できない（トークンなしは 401）', async () => {
    app = await buildApp({ config, verifier, logger: false });
    const res = await app.inject({ method: 'HEAD', url: '/api/session' });
    expect(res.statusCode).toBe(401);
  });

  it('ヘルスチェックと存在しないパスは認証しない（200・404）', async () => {
    app = await buildApp({ config, verifier, logger: false });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/unknown' })).statusCode).toBe(404);
  });
});

describe('日時の形式', () => {
  it('UNIX 秒を日本時間の ISO 8601 にする（日付をまたぐ場合も）', () => {
    expect(toJstIso(0)).toBe('1970-01-01T09:00:00+09:00');
    expect(toJstIso(Date.UTC(2026, 10, 2, 15) / 1000)).toBe('2026-11-03T00:00:00+09:00');
  });
});

describe('ログ', () => {
  /** 本番と同じログ設定で要求を1件処理し、出力されたログを返す */
  const logOf = async (url: string, token: string) => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    app = await buildApp({ config, verifier, logger: { ...loggerOptions('info'), stream } });
    await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    return lines.join('');
  };

  it('要求ログに URL のクエリ文字列と Authorization ヘッダーを出さない', async () => {
    const token = sign();
    const log = await logOf('/api/session?q=東京都千代田区&code=secret-code&state=xyz', token);
    expect(log).toContain('"url":"/api/session"');
    expect(log).not.toMatch(/千代田|secret-code|state=|q=/);
    expect(log).not.toContain(token);
  });

  it('不正なトークンは理由（例外の種類）だけを info で残し、トークンの中身は出さない', async () => {
    const log = await logOf('/api/session', sign({ client_id: 'other-client', sub: 'user-999' }));
    expect(log).toContain('"reason":"CognitoJwtInvalidClientIdError"');
    expect(log).not.toMatch(/"level":40|user-999/);
  });
});
