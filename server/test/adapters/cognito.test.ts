import { describe, expect, it } from 'vitest';
import { CognitoTokenRejectedError, createCognitoUserClient } from '../../src/adapters/cognito.js';
import { ExternalApiError } from '../../src/adapters/http.js';
import { createFakeFetch, json } from '../helpers/fake-fetch.js';

const URL = 'https://cognito-idp.ap-northeast-1.amazonaws.com/';
const getUserResponse = (email?: string) =>
  json({
    Username: 'user-123',
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      ...(email ? [{ Name: 'email', Value: email }] : []),
    ],
  });

function setup(...responses: Response[]) {
  const api = createFakeFetch().on('POST', URL, ...responses.map((r) => () => r.clone()));
  let time = 1_000_000;
  const client = createCognitoUserClient({
    userPoolId: 'ap-northeast-1_TestPool1',
    fetch: api.fetch,
    retries: 0,
    now: () => time,
  });
  return { api, client, advance: (ms: number) => (time += ms) };
}

describe('Cognito の利用者情報', () => {
  it('アクセストークンで GetUser を呼び、メールアドレスを返す', async () => {
    const { api, client } = setup(getUserResponse('user@example.com'));
    expect(await client.getEmail('user-123', 'access-token')).toBe('user@example.com');
    const call = api.calls[0]!;
    expect(call.headers.get('x-amz-target')).toBe('AWSCognitoIdentityProviderService.GetUser');
    expect(call.headers.get('content-type')).toBe('application/x-amz-json-1.1');
    expect(call.body).toEqual({ AccessToken: 'access-token' });
  });

  it('同じ利用者は5分間、Cognito に問い合わせ直さない', async () => {
    const { api, client, advance } = setup(
      getUserResponse('old@example.com'),
      getUserResponse('new@example.com'),
    );
    expect(await client.getEmail('user-123', 't1')).toBe('old@example.com');
    advance(4 * 60 * 1000);
    expect(await client.getEmail('user-123', 't2')).toBe('old@example.com');
    expect(api.calls).toHaveLength(1);
    advance(61 * 1000);
    expect(await client.getEmail('user-123', 't3')).toBe('new@example.com');
    expect(api.calls).toHaveLength(2);
  });

  it('ほかの利用者の結果を使い回さない', async () => {
    const { client } = setup(getUserResponse('a@example.com'), getUserResponse('b@example.com'));
    expect(await client.getEmail('user-a', 't')).toBe('a@example.com');
    expect(await client.getEmail('user-b', 't')).toBe('b@example.com');
  });

  it.each(['NotAuthorizedException', 'UserNotFoundException'])(
    'トークンが失効していれば（%s）CognitoTokenRejectedError にする',
    async (type) => {
      // 実際の Cognito は、種類を「名前:」の形でヘッダーに入れて返す
      const { client } = setup(json({ __type: type }, 400, { 'x-amzn-errortype': `${type}:` }));
      await expect(client.getEmail('user-123', 't')).rejects.toBeInstanceOf(
        CognitoTokenRejectedError,
      );
    },
  );

  it('失効が分かったら、覚えていたメールアドレスも捨てる', async () => {
    const { client, advance, api } = setup(
      getUserResponse('user@example.com'),
      json({}, 400, { 'x-amzn-errortype': 'NotAuthorizedException:' }),
      getUserResponse('user@example.com'),
    );
    await client.getEmail('user-123', 't1');
    advance(6 * 60 * 1000); // 覚えておく時間が切れて、問い合わせ直す
    await expect(client.getEmail('user-123', 't2')).rejects.toBeInstanceOf(
      CognitoTokenRejectedError,
    );
    await client.getEmail('user-123', 't3');
    expect(api.calls).toHaveLength(3);
  });

  it('それ以外の失敗（回数制限など）は ExternalApiError のままにする', async () => {
    const { client } = setup(
      json({ __type: 'TooManyRequestsException' }, 400, {
        'x-amzn-errortype': 'TooManyRequestsException:',
      }),
    );
    const error = await client.getEmail('user-123', 't').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalApiError);
    expect((error as ExternalApiError).errorType).toBe('TooManyRequestsException');
  });

  it('メールアドレスのない利用者は例外にする', async () => {
    const { client } = setup(getUserResponse());
    await expect(client.getEmail('user-123', 't')).rejects.toThrow('メールアドレス');
  });
});
