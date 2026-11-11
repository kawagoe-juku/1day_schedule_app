/** 外部 API クライアントの入口。サーバ起動時に createExternalClients(config) で作る */
import type { Config } from '../config.js';
import { createGoogleMapsClient, type GoogleMapsClient } from './google-maps.js';
import type { HttpOptions } from './http.js';
import { createEmfMetrics } from './metrics.js';
import { createNavitimeClient, type NavitimeClient } from './navitime.js';

export interface ExternalClients {
  /** キーが未設定の環境（ローカルなど）では undefined */
  googleMaps?: GoogleMapsClient;
  navitime?: NavitimeClient;
}

export function createExternalClients(
  config: Pick<Config, 'APP_STAGE' | 'GOOGLE_MAPS_SERVER_KEY' | 'NAVITIME_RAPIDAPI_KEY'>,
  /** テスト用（fetch の差し替えなど）。指定しなければ、呼び出し回数を EMF で標準出力に書く */
  http: HttpOptions = {},
): ExternalClients {
  const options = { metrics: createEmfMetrics({ stage: config.APP_STAGE }), ...http };
  return {
    googleMaps: config.GOOGLE_MAPS_SERVER_KEY
      ? createGoogleMapsClient({ apiKey: config.GOOGLE_MAPS_SERVER_KEY, ...options })
      : undefined,
    navitime: config.NAVITIME_RAPIDAPI_KEY
      ? createNavitimeClient({ apiKey: config.NAVITIME_RAPIDAPI_KEY, ...options })
      : undefined,
  };
}
