/**
 * Google Maps のクライアント（サーバ用キー）。使う API は次の3つ：
 * - Geocoding API：住所 → 座標
 * - Places API (New)：住所の候補、場所の詳細、店舗の検索
 * - Routes API：徒歩・自転車・車の経路
 * 公共交通（電車）の経路は NAVITIME を使う（navitime.ts）。
 */
import { z } from 'zod';
import { ExternalApiError, requestJson, type HttpOptions } from './http.js';

const SERVICE = 'google_maps';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeocodeResult {
  placeId: string;
  formattedAddress: string;
  location: LatLng;
}

export interface AddressSuggestion {
  placeId: string;
  /** 候補の全文（例：東京都千代田区丸の内1丁目） */
  description: string;
}

export interface Place {
  placeId: string;
  name: string;
  address?: string;
  location?: LatLng;
  /** 今営業しているか（営業時間の情報が無い場所は undefined） */
  openNow?: boolean;
}

export interface PlaceSearch {
  /** 探す言葉（例：スーパー、ドラッグストア マツモトキヨシ） */
  query: string;
  /** この地点の近くを優先する */
  near?: LatLng;
  /** near からの半径（既定 1000m） */
  radiusMeters?: number;
  /** 最大件数（既定 10、上限 20） */
  maxResults?: number;
  /** true なら、今営業している場所だけ */
  openNow?: boolean;
}

export type RouteMode = 'walk' | 'bicycle' | 'car';

export interface RouteRequest {
  origin: LatLng;
  destination: LatLng;
  mode: RouteMode;
  /** 出発時刻（車の渋滞を考慮するとき。未来の時刻のみ） */
  departureTime?: Date;
}

export interface Route {
  distanceMeters: number;
  durationSeconds: number;
  /** 地図に線を引くための符号化済みポリライン */
  polyline?: string;
}

export interface GoogleMapsClientOptions extends HttpOptions {
  apiKey: string;
}

export interface GoogleMapsClient {
  /** 住所を座標にする。見つからなければ undefined */
  geocode(address: string): Promise<GeocodeResult | undefined>;
  /** 入力途中の住所から候補を返す（0件も正常）。sessionToken は同じ入力の間は同じ値を渡す */
  suggestAddresses(
    input: string,
    options?: { sessionToken?: string },
  ): Promise<AddressSuggestion[]>;
  /** 候補から選ばれた場所の詳細。見つからなければ undefined */
  getPlace(placeId: string, options?: { sessionToken?: string }): Promise<Place | undefined>;
  /** 店舗などを探す（0件も正常） */
  searchPlaces(search: PlaceSearch): Promise<Place[]>;
  /** 2地点間の経路。経路が無ければ undefined */
  computeRoute(request: RouteRequest): Promise<Route | undefined>;
}

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const PLACES_URL = 'https://places.googleapis.com/v1';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

// ---- 応答の形（使う項目だけ。知らない項目は無視する）
const GeocodeResponse = z.object({
  status: z.string(),
  results: z
    .array(
      z.object({
        place_id: z.string(),
        formatted_address: z.string(),
        geometry: z.object({ location: z.object({ lat: z.number(), lng: z.number() }) }),
      }),
    )
    .default([]),
});

const AutocompleteResponse = z.object({
  suggestions: z
    .array(
      z.object({
        // 住所以外の候補（検索語の候補）は placePrediction を持たない
        placePrediction: z
          .object({ placeId: z.string(), text: z.object({ text: z.string() }) })
          .optional(),
      }),
    )
    .default([]),
});

const PlaceResponse = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  currentOpeningHours: z.object({ openNow: z.boolean().optional() }).optional(),
});

const SearchTextResponse = z.object({ places: z.array(PlaceResponse).default([]) });

const RoutesResponse = z.object({
  routes: z
    .array(
      z.object({
        // 出発地と目的地が同じ場合などは 0 で、項目ごと省略される
        distanceMeters: z.number().default(0),
        // 「123s」の形式
        duration: z.string().regex(/^\d+(\.\d+)?s$/),
        polyline: z.object({ encodedPolyline: z.string() }).optional(),
      }),
    )
    .default([]),
});

const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'currentOpeningHours'];
const TRAVEL_MODES: Record<RouteMode, string> = { walk: 'WALK', bicycle: 'BICYCLE', car: 'DRIVE' };

const toPlace = (p: z.infer<typeof PlaceResponse>): Place => ({
  placeId: p.id,
  name: p.displayName?.text ?? '',
  address: p.formattedAddress,
  location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
  openNow: p.currentOpeningHours?.openNow,
});

const toLatLng = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

export function createGoogleMapsClient(options: GoogleMapsClientOptions): GoogleMapsClient {
  const { apiKey, ...http } = options;
  // Places API (New) と Routes API は、キーをヘッダーで渡す
  const keyHeader = { 'x-goog-api-key': apiKey };

  return {
    async geocode(address) {
      // Geocoding API はキーをクエリで渡す仕様。URL はログやエラーに出さない（http.ts）
      const url = new URL(GEOCODE_URL);
      url.search = new URLSearchParams({
        address,
        language: 'ja',
        region: 'jp',
        key: apiKey,
      }).toString();
      const operation = 'geocode';
      const res = await requestJson(
        { service: SERVICE, operation, url, schema: GeocodeResponse },
        http,
      );
      if (res.status === 'ZERO_RESULTS') return undefined;
      // キーの制限違反・上限超過などは、HTTP 200 のまま status で返ってくる
      if (res.status !== 'OK') {
        throw new ExternalApiError(SERVICE, operation, 'invalid_response', undefined, res.status);
      }
      const first = res.results[0];
      if (!first) return undefined;
      return {
        placeId: first.place_id,
        formattedAddress: first.formatted_address,
        location: first.geometry.location,
      };
    },

    async suggestAddresses(input, { sessionToken } = {}) {
      const res = await requestJson(
        {
          service: SERVICE,
          operation: 'places_autocomplete',
          method: 'POST',
          url: `${PLACES_URL}/places:autocomplete`,
          headers: keyHeader,
          body: {
            input,
            languageCode: 'ja',
            regionCode: 'jp',
            includedRegionCodes: ['jp'],
            ...(sessionToken ? { sessionToken } : {}),
          },
          schema: AutocompleteResponse,
        },
        http,
      );
      return res.suggestions.flatMap((s) =>
        s.placePrediction
          ? [{ placeId: s.placePrediction.placeId, description: s.placePrediction.text.text }]
          : [],
      );
    },

    async getPlace(placeId, { sessionToken } = {}) {
      const url = new URL(`${PLACES_URL}/places/${encodeURIComponent(placeId)}`);
      url.searchParams.set('languageCode', 'ja');
      url.searchParams.set('regionCode', 'jp');
      if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
      try {
        const res = await requestJson(
          {
            service: SERVICE,
            operation: 'place_details',
            url,
            headers: { ...keyHeader, 'x-goog-fieldmask': PLACE_FIELDS.join(',') },
            schema: PlaceResponse,
          },
          http,
        );
        return toPlace(res);
      } catch (error) {
        // 無い ID・古くなった ID は「見つからない」として扱う
        if (error instanceof ExternalApiError && error.status === 404) return undefined;
        throw error;
      }
    },

    async searchPlaces({ query, near, radiusMeters = 1000, maxResults = 10, openNow }) {
      const res = await requestJson(
        {
          service: SERVICE,
          operation: 'places_search_text',
          method: 'POST',
          url: `${PLACES_URL}/places:searchText`,
          headers: {
            ...keyHeader,
            'x-goog-fieldmask': PLACE_FIELDS.map((f) => `places.${f}`).join(','),
          },
          body: {
            textQuery: query,
            languageCode: 'ja',
            regionCode: 'jp',
            maxResultCount: Math.min(Math.max(maxResults, 1), 20),
            ...(openNow ? { openNow: true } : {}),
            ...(near
              ? {
                  locationBias: {
                    circle: {
                      center: { latitude: near.lat, longitude: near.lng },
                      radius: radiusMeters,
                    },
                  },
                }
              : {}),
          },
          schema: SearchTextResponse,
        },
        http,
      );
      return res.places.map(toPlace);
    },

    async computeRoute({ origin, destination, mode, departureTime }) {
      const res = await requestJson(
        {
          service: SERVICE,
          operation: 'compute_routes',
          method: 'POST',
          url: ROUTES_URL,
          headers: {
            ...keyHeader,
            'x-goog-fieldmask':
              'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
          },
          body: {
            origin: toLatLng(origin),
            destination: toLatLng(destination),
            travelMode: TRAVEL_MODES[mode],
            languageCode: 'ja',
            regionCode: 'jp',
            units: 'METRIC',
            // 渋滞の考慮は車だけ（他の手段で指定するとエラーになる）
            ...(mode === 'car' && departureTime
              ? { routingPreference: 'TRAFFIC_AWARE', departureTime: departureTime.toISOString() }
              : {}),
          },
          schema: RoutesResponse,
        },
        http,
      );
      const first = res.routes[0];
      if (!first) return undefined;
      return {
        distanceMeters: first.distanceMeters,
        durationSeconds: Math.round(Number.parseFloat(first.duration)),
        polyline: first.polyline?.encodedPolyline,
      };
    },
  };
}
