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

/** 2点間の直線距離（m） */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
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
  /**
   * 今日から7日分の営業時間（祝日・臨時休業を反映したもの）。営業時間の情報が無い場所は undefined。
   * close が無い時間帯は、終わりなく営業（24時間営業）
   */
  openingPeriods?: OpeningPeriod[];
}

export interface OpeningPeriod {
  /** ISO 8601（日本時間、+09:00 付き） */
  open: string;
  close?: string;
}

/**
 * その日時に営業しているか。営業時間の情報が無い場所は undefined（分からない）。
 * 立寄りの時刻は「今」ではないので、openNow ではなくこれで確かめる
 */
export function isOpenAt(place: Pick<Place, 'openingPeriods'>, at: Date): boolean | undefined {
  if (!place.openingPeriods) return undefined;
  const time = at.getTime();
  return place.openingPeriods.some(
    (p) => Date.parse(p.open) <= time && (p.close === undefined || time < Date.parse(p.close)),
  );
}

/**
 * from から to まで、途切れずに営業しているか（時間帯が続いていれば可。昼休みなどをまたぐなら不可）。
 * 営業時間の情報が無い場所は undefined
 */
export function isOpenDuring(
  place: Pick<Place, 'openingPeriods'>,
  from: Date,
  to: Date,
): boolean | undefined {
  const periods = place.openingPeriods?.map((p) => ({
    open: Date.parse(p.open),
    close: p.close === undefined ? Infinity : Date.parse(p.close),
  }));
  if (!periods) return undefined;
  let time = from.getTime();
  for (let i = 0; i <= periods.length && time < to.getTime(); i++) {
    const period = periods.find((p) => p.open <= time && time < p.close);
    if (!period) return false;
    time = period.close;
  }
  return time >= to.getTime();
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
  /** basic なら、営業時間を取得しない（料金の区分が下がる）。既定は営業時間つき */
  fields?: 'basic' | 'hours';
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

/** 営業時間の開始・終了（日付は、祝日などを反映した「今日から7日分」のときだけ付く） */
const OpeningPoint = z.object({
  date: z.object({ year: z.number(), month: z.number(), day: z.number() }).optional(),
  hour: z.number().default(0),
  minute: z.number().default(0),
});

const PlaceResponse = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
  currentOpeningHours: z
    .object({
      openNow: z.boolean().optional(),
      periods: z.array(z.object({ open: OpeningPoint, close: OpeningPoint.optional() })).optional(),
    })
    .optional(),
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

const BASIC_FIELDS = ['id', 'displayName', 'formattedAddress', 'location'];
const PLACE_FIELDS = [
  ...BASIC_FIELDS,
  'currentOpeningHours.openNow',
  'currentOpeningHours.periods',
];
const TRAVEL_MODES: Record<RouteMode, string> = { walk: 'WALK', bicycle: 'BICYCLE', car: 'DRIVE' };

const pad = (value: number) => String(value).padStart(2, '0');
/** Google の営業時間（その場所の現地時刻。日本国内なので日本時間）を ISO 8601 にする */
const toJstIso = (point: z.infer<typeof OpeningPoint>): string | undefined =>
  point.date
    ? `${point.date.year}-${pad(point.date.month)}-${pad(point.date.day)}T${pad(point.hour)}:${pad(point.minute)}:00+09:00`
    : undefined;

type RawPeriod = { open: z.infer<typeof OpeningPoint>; close?: z.infer<typeof OpeningPoint> };
/**
 * 営業時間を、日時の組にする。日付の無い時間帯は、どの日のものか決められないので使わない。
 * 使える時間帯が1つも残らなければ、営業時間は「分からない」（undefined）として扱う
 * （「休み」や「終わりなく営業」と取り違えない）
 */
function toOpeningPeriods(periods: RawPeriod[] | undefined): OpeningPeriod[] | undefined {
  if (!periods) return undefined;
  const usable = periods.flatMap((period) => {
    const open = toJstIso(period.open);
    const close = period.close && toJstIso(period.close);
    if (!open || (period.close && !close)) return [];
    return [{ open, close: close || undefined }];
  });
  return periods.length > 0 && usable.length === 0 ? undefined : usable;
}

const toPlace = (p: z.infer<typeof PlaceResponse>): Place => ({
  placeId: p.id,
  name: p.displayName?.text ?? '',
  address: p.formattedAddress,
  location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : undefined,
  openNow: p.currentOpeningHours?.openNow,
  openingPeriods: toOpeningPeriods(p.currentOpeningHours?.periods),
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

    async searchPlaces({ query, near, radiusMeters = 1000, maxResults = 10, openNow, fields }) {
      const res = await requestJson(
        {
          service: SERVICE,
          operation: 'places_search_text',
          method: 'POST',
          url: `${PLACES_URL}/places:searchText`,
          headers: {
            ...keyHeader,
            'x-goog-fieldmask': (fields === 'basic' ? BASIC_FIELDS : PLACE_FIELDS)
              .map((f) => `places.${f}`)
              .join(','),
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
