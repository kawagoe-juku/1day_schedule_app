import { describe, expect, it } from 'vitest';
import { createFakeFetch, hang, json, networkError, status } from './helpers/fake-fetch.js';

const URL_ITEMS = 'https://api.example.com/v1/items';

describe('createFakeFetch（外部 API のモック）', () => {
  it('登録した応答を返し、要求を記録する（クエリ・ヘッダー・本文）', async () => {
    const api = createFakeFetch().on('POST', URL_ITEMS, () => json({ id: 1 }, 201));
    const res = await api.fetch(`${URL_ITEMS}?lang=ja`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
      body: JSON.stringify({ name: '牛乳' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 1 });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.method).toBe('POST');
    expect(api.calls[0]?.url.searchParams.get('lang')).toBe('ja');
    expect(api.calls[0]?.headers.get('x-api-key')).toBe('k');
    expect(api.calls[0]?.body).toEqual({ name: '牛乳' });
  });

  it('複数登録すると順に返し、最後の応答を繰り返す（5xx の後に成功、など）', async () => {
    const api = createFakeFetch().on(
      'GET',
      URL_ITEMS,
      () => status(503),
      () => json({ ok: true }),
    );
    expect((await api.fetch(URL_ITEMS)).status).toBe(503);
    expect((await api.fetch(URL_ITEMS)).status).toBe(200);
    expect((await api.fetch(URL_ITEMS)).status).toBe(200);
    expect(api.calls).toHaveLength(3);
  });

  it('登録していない宛先は例外にする（本物の API を呼ばない）', async () => {
    const api = createFakeFetch().on('GET', URL_ITEMS, () => json({}));
    await expect(api.fetch('https://api.example.com/v1/other')).rejects.toThrow('登録していない');
    await expect(api.fetch(URL_ITEMS, { method: 'DELETE' })).rejects.toThrow('登録していない');
  });

  it('hang は応答を返さず、タイムアウトで打ち切ると失敗する', async () => {
    const api = createFakeFetch().on('GET', URL_ITEMS, hang);
    const pending = api.fetch(URL_ITEMS, { signal: AbortSignal.timeout(20) });
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('networkError は通信エラー（TypeError）で失敗する', async () => {
    const api = createFakeFetch().on('GET', URL_ITEMS, networkError);
    await expect(api.fetch(URL_ITEMS)).rejects.toThrow(TypeError);
  });
});
