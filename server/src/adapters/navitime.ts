/**
 * NAVITIME のクライアント（RapidAPI 経由）。
 * - 乗換経路：NAVITIME Route(totalnavi) の /route_transit（駅の出入口・乗車位置・運賃も返る）
 * - 駅名の候補：NAVITIME Transport の /transport_node/autocomplete
 * RapidAPI では API ごとに購読が必要で、ホスト名も API ごとに違う（キーは共通）。
 */
import { z } from 'zod';
import { requestJson, type HttpOptions } from './http.js';
import type { LatLng } from './google-maps.js';

const SERVICE = 'navitime';
const ROUTE_HOST = 'navitime-route-totalnavi.p.rapidapi.com';
const TRANSPORT_HOST = 'navitime-transport.p.rapidapi.com';

export interface TransitRouteRequest {
  /** 出発地（座標、または駅の ID） */
  start: LatLng | string;
  /** 目的地（座標、または駅の ID） */
  goal: LatLng | string;
  /** 出発時刻で探す（arriveBy とどちらか一方） */
  departAt?: Date;
  /** 到着時刻で探す（departAt とどちらか一方） */
  arriveBy?: Date;
  /** 経路の件数（1〜10、既定 3） */
  limit?: number;
  /** 徒歩の速さ（km/h、3.0〜8.0。未指定は NAVITIME の標準 4.8） */
  walkSpeedKmh?: number;
  /** 並び順（既定は time_optimized：早く着く順／遅く出る順） */
  order?: 'time_optimized' | 'time' | 'fare' | 'transit' | 'walk_distance';
}

/** 経路の中の地点（出発地・駅・目的地） */
export interface TransitPoint {
  kind: 'point';
  /** 駅名。出発地・目的地は start／goal */
  name: string;
  location: LatLng;
  /** 駅の ID（駅のときだけ） */
  stationCode?: string;
  /** 使う出入口（例：八重洲中央口、B6口）。情報がある駅だけ */
  gateway?: string;
}

/** 経路の中の移動（徒歩・電車など） */
export interface TransitMove {
  kind: 'move';
  /** walk・local_train・rapid_train など（NAVITIME の値のまま） */
  mode: string;
  /** 路線名（徒歩は「徒歩」） */
  lineName: string;
  /** ISO 8601（日本時間、+09:00 付き） */
  departureTime: string;
  arrivalTime: string;
  durationMinutes: number;
  distanceMeters?: number;
  /** 種別（普通・快速など）。電車のときだけ */
  trainType?: string;
  /** 事業者名（電車のときだけ） */
  companyName?: string;
  /** 行き先（○○方面） */
  direction?: string;
  /** 乗り換えに便利な乗車位置（例：前・中・後、1・2・3号車）。情報がある区間だけ */
  boardingPosition?: string;
}

export type TransitSection = TransitPoint | TransitMove;

export interface TransitRoute {
  departureTime: string;
  arrivalTime: string;
  durationMinutes: number;
  /** 乗り換え回数 */
  transferCount: number;
  walkDistanceMeters: number;
  /** 運賃（円）。徒歩だけの経路では undefined */
  fare?: { ticketYen: number; icYen: number };
  sections: TransitSection[];
}

export interface StationSuggestion {
  stationCode: string;
  stationName: string;
  /** よみ（ひらがな） */
  ruby?: string;
  /** 所在地（例：東京都千代田区丸の内）。先頭が都道府県 */
  address?: string;
  location?: LatLng;
}

export interface NavitimeClientOptions extends HttpOptions {
  apiKey: string;
}

export interface NavitimeClient {
  /** 乗換経路を探す（経路が無ければ空の配列） */
  searchTransitRoutes(request: TransitRouteRequest): Promise<TransitRoute[]>;
  /** 駅名の候補を返す（2文字以上。0件も正常） */
  suggestStations(word: string, options?: { limit?: number }): Promise<StationSuggestion[]>;
}

// ---- 応答の形（使う項目だけ。知らない項目は無視する）
const Coord = z.object({ lat: z.number(), lon: z.number() });

const PointSection = z.object({
  type: z.literal('point'),
  name: z.string(),
  coord: Coord,
  node_id: z.string().optional(),
  gateway: z.string().optional(),
});

const MoveSection = z.object({
  type: z.literal('move'),
  move: z.string(),
  line_name: z.string().optional(),
  from_time: z.string(),
  to_time: z.string(),
  time: z.number(),
  distance: z.number().optional(),
  transport: z
    .object({
      name: z.string().optional(),
      type: z.string().optional(),
      getoff: z.string().optional(),
      company: z.object({ name: z.string().optional() }).optional(),
      links: z.array(z.object({ way: z.string().optional() })).optional(),
    })
    .optional(),
});

const RouteTransitResponse = z.object({
  items: z
    .array(
      z.object({
        summary: z.object({
          move: z.object({
            from_time: z.string(),
            to_time: z.string(),
            time: z.number(),
            transit_count: z.number().default(0),
            walk_distance: z.number().default(0),
            // unit_0 がきっぷ、unit_48 が IC の運賃
            fare: z.record(z.string(), z.number()).optional(),
            reference_fare: z
              .object({
                lowest_total_ticket: z.number().optional(),
                lowest_total_ic: z.number().optional(),
              })
              .optional(),
          }),
        }),
        sections: z.array(z.discriminatedUnion('type', [PointSection, MoveSection])),
      }),
    )
    .default([]),
});

const AutocompleteResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        ruby: z.string().optional(),
        address_name: z.string().nullish(),
        coord: Coord.optional(),
      }),
    )
    .default([]),
});

/** NAVITIME の日時の形式（日本時間の YYYY-MM-DDThh:mm:ss。時差の表記は付けない） */
export function toNavitimeTime(date: Date): string {
  return new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 19);
}

const toPosition = (p: LatLng | string) => (typeof p === 'string' ? p : `${p.lat},${p.lng}`);

type RouteItem = z.infer<typeof RouteTransitResponse>['items'][number];

function toFare(move: RouteItem['summary']['move']): TransitRoute['fare'] {
  const ticket = move.reference_fare?.lowest_total_ticket ?? move.fare?.unit_0;
  if (ticket === undefined) return undefined;
  const ic = move.reference_fare?.lowest_total_ic ?? move.fare?.unit_48 ?? ticket;
  return { ticketYen: Math.round(ticket), icYen: Math.round(ic) };
}

function toSection(section: RouteItem['sections'][number]): TransitSection {
  if (section.type === 'point') {
    return {
      kind: 'point',
      name: section.name,
      location: { lat: section.coord.lat, lng: section.coord.lon },
      stationCode: section.node_id,
      gateway: section.gateway,
    };
  }
  return {
    kind: 'move',
    mode: section.move,
    lineName: section.transport?.name ?? section.line_name ?? '',
    departureTime: section.from_time,
    arrivalTime: section.to_time,
    durationMinutes: section.time,
    distanceMeters: section.distance,
    trainType: section.transport?.type,
    companyName: section.transport?.company?.name,
    direction: section.transport?.links?.[0]?.way,
    boardingPosition: section.transport?.getoff,
  };
}

export function createNavitimeClient(options: NavitimeClientOptions): NavitimeClient {
  const { apiKey, ...http } = options;
  const headers = (host: string) => ({ 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host });

  return {
    async searchTransitRoutes({ start, goal, departAt, arriveBy, limit = 3, walkSpeedKmh, order }) {
      if (departAt && arriveBy) {
        throw new Error('departAt と arriveBy は、どちらか一方だけを指定してください');
      }
      const params = new URLSearchParams({
        start: toPosition(start),
        goal: toPosition(goal),
        limit: String(Math.min(Math.max(limit, 1), 10)),
      });
      if (arriveBy) params.set('goal_time', toNavitimeTime(arriveBy));
      else params.set('start_time', toNavitimeTime(departAt ?? new Date()));
      if (walkSpeedKmh !== undefined) {
        params.set('walk_speed', Math.min(Math.max(walkSpeedKmh, 3), 8).toFixed(1));
      }
      if (order) params.set('order', order);

      const res = await requestJson(
        {
          service: SERVICE,
          operation: 'route_transit',
          url: `https://${ROUTE_HOST}/route_transit?${params.toString()}`,
          headers: headers(ROUTE_HOST),
          schema: RouteTransitResponse,
        },
        http,
      );
      return res.items.map((item) => ({
        departureTime: item.summary.move.from_time,
        arrivalTime: item.summary.move.to_time,
        durationMinutes: item.summary.move.time,
        transferCount: item.summary.move.transit_count,
        walkDistanceMeters: item.summary.move.walk_distance,
        fare: toFare(item.summary.move),
        sections: item.sections.map(toSection),
      }));
    },

    async suggestStations(word, { limit = 10 } = {}) {
      // NAVITIME の仕様で、2文字未満は検索できない
      if (word.trim().length < 2) return [];
      const params = new URLSearchParams({ word: word.trim(), type: 'station' });
      const res = await requestJson(
        {
          service: SERVICE,
          operation: 'transport_node_autocomplete',
          url: `https://${TRANSPORT_HOST}/transport_node/autocomplete?${params.toString()}`,
          headers: headers(TRANSPORT_HOST),
          schema: AutocompleteResponse,
        },
        http,
      );
      return res.items.slice(0, limit).map((item) => ({
        stationCode: item.id,
        stationName: item.name,
        ruby: item.ruby,
        address: item.address_name ?? undefined,
        location: item.coord ? { lat: item.coord.lat, lng: item.coord.lon } : undefined,
      }));
    },
  };
}
