import { describe, expect, it } from 'vitest';
import { createExternalClients } from '../../src/adapters/index.js';
import { loadConfig } from '../../src/config.js';
import { createFakeFetch, json } from '../helpers/fake-fetch.js';

describe('createExternalClients', () => {
  it('キーが未設定なら、そのクライアントは作らない', () => {
    expect(createExternalClients(loadConfig({}))).toEqual({
      googleMaps: undefined,
      navitime: undefined,
    });
  });

  it('設定のキーでクライアントを作る', async () => {
    const api = createFakeFetch().on(
      'GET',
      'https://navitime-transport.p.rapidapi.com/transport_node/autocomplete',
      () => json({ items: [] }),
    );
    const config = loadConfig({ GOOGLE_MAPS_SERVER_KEY: 'g-key', NAVITIME_RAPIDAPI_KEY: 'n-key' });
    const clients = createExternalClients(config, {
      fetch: api.fetch,
      metrics: { record() {} },
    });
    expect(clients.googleMaps).toBeDefined();
    await clients.navitime?.suggestStations('新宿');
    expect(api.calls[0]?.headers.get('x-rapidapi-key')).toBe('n-key');
  });
});
