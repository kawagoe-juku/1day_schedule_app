import type { FastifyInstance } from 'fastify';
import type { GoogleMapsClient } from '../adapters/google-maps.js';
import type { NavitimeClient } from '../adapters/navitime.js';
import { externalServiceError, unauthorized } from '../errors.js';
import { createRateLimiter, type RateLimiter } from '../rate-limit.js';

export interface GeoRouteOptions {
  /** キーが未設定の環境では undefined（候補の API は 502 を返す） */
  googleMaps?: Pick<GoogleMapsClient, 'suggestAddresses'>;
  navitime?: Pick<NavitimeClient, 'suggestStations'>;
  /** テスト用。指定しなければ、利用者ごとに SUGGEST_RATE_LIMIT で制限する */
  rateLimiter?: RateLimiter;
}

/**
 * 候補の API の回数制限（利用者ごと、住所と駅名の合計）。
 * 画面は入力が止まってから問い合わせるので、通常の利用では届かない。
 * 連打による外部 API（有料）の課金と利用枠の消費を抑えるためのもの。
 */
export const SUGGEST_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/** API 仕様（api/openapi.yaml）の SuggestQuery・SuggestLimit */
const suggestQuerystring = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 100 },
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
  },
} as const;

interface SuggestQuery {
  q: string;
  limit: number;
}

const PREFECTURE = /^(北海道|東京都|(?:京都|大阪)府|.{2,3}県)/;

/** 所在地（例：東京都千代田区丸の内）の先頭から都道府県を取り出す。取り出せなければ undefined */
export function toPrefecture(address: string | undefined): string | undefined {
  return address ? PREFECTURE.exec(address)?.[1] : undefined;
}

/** 住所・駅名の候補（オンボーディングとプロファイル編集の入力補助） */
export async function geoRoutes(app: FastifyInstance, opts: GeoRouteOptions): Promise<void> {
  const rateLimiter = opts.rateLimiter ?? createRateLimiter(SUGGEST_RATE_LIMIT);
  const notConfigured = (name: string) => {
    app.log.warn(`${name} が未設定のため、候補を取得できません`);
    return externalServiceError();
  };

  app.get<{ Querystring: SuggestQuery }>(
    '/api/geo/address-suggestions',
    { schema: { querystring: suggestQuerystring } },
    async (request) => {
      if (!request.user) throw unauthorized();
      if (!opts.googleMaps) throw notConfigured('GOOGLE_MAPS_SERVER_KEY');
      const { q, limit } = request.query;
      if (q.trim() === '') return { items: [] };
      rateLimiter.consume(request.user.sub);
      const suggestions = await opts.googleMaps.suggestAddresses(q.trim());
      return {
        items: suggestions
          .slice(0, limit)
          .map(({ placeId, description }) => ({ placeId, description })),
      };
    },
  );

  app.get<{ Querystring: SuggestQuery }>(
    '/api/geo/station-suggestions',
    { schema: { querystring: suggestQuerystring } },
    async (request) => {
      if (!request.user) throw unauthorized();
      if (!opts.navitime) throw notConfigured('NAVITIME_RAPIDAPI_KEY');
      const { q, limit } = request.query;
      rateLimiter.consume(request.user.sub);
      // 乗換案内 API は2文字以上でないと探せない（1文字のときは 0 件が返る）
      const suggestions = await opts.navitime.suggestStations(q, { limit });
      return {
        items: suggestions.map(({ stationCode, stationName, address }) => {
          const prefecture = toPrefecture(address);
          return { stationCode, stationName, ...(prefecture ? { prefecture } : {}) };
        }),
      };
    },
  );
}
