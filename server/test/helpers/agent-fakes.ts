/**
 * 計画生成のテスト用の代用品（AI・Google Maps・移動）と、よく使う入力。
 */
import type { GoogleMapsClient, Place, PlaceSearch } from '../../src/adapters/google-maps.js';
import type { NavitimeClient, TransitRouteRequest } from '../../src/adapters/navitime.js';
import type { Ai, AiCall } from '../../src/agent/ai.js';
import type { Travel } from '../../src/agent/compose.js';
import { SLOT_IDS } from '../../src/agent/slots.js';

export const NOW = new Date('2026-11-25T09:00:00+09:00');
export const at = (time: string, date = '2026-11-25') => `${date}T${time}:00+09:00`;
export const HOME = { lat: 35.64, lng: 139.67 };
export const TOKYO = { lat: 35.6812, lng: 139.7671 };
export const INPUT = '東京駅に13時に待ち合わせ。カレーの食材を買いたい';

export const errand = (overrides: Record<string, unknown> = {}) => ({
  id: null,
  sameAs: null,
  title: '待ち合わせ',
  kind: 'other',
  place: '東京駅',
  placeIsSpecific: true,
  startTime: '13:00',
  endTime: '14:00',
  ...overrides,
});
export const SUPERMARKET = {
  id: null,
  category: 'supermarket',
  chain: null,
  perishable: true,
  items: ['カレーの食材'],
};
export const intent = (overrides: Record<string, unknown> = {}) => ({
  rejected: false,
  date: 'today',
  mode: 'train',
  errands: [errand()],
  stops: [SUPERMARKET],
  removedIds: [],
  shoppingTime: null,
  assumptions: [],
  ...overrides,
});

export interface DecideData {
  candidates: { stopId: string; candidate: string; when: string[] }[];
}
/** 判断（AI②）の既定の答え：全スロットを評価し、立寄りごとに最初の候補を選ぶ（後に寄れるなら後） */
export const decide = (data: DecideData) => ({
  slots: SLOT_IDS.map((slot) => ({ slot, decision: '問題なし' })),
  stopovers: [...new Set(data.candidates.map((c) => c.stopId))].map((stopId) => {
    const first = data.candidates.find((c) => c.stopId === stopId)!;
    return { stopId, candidate: first.candidate, when: first.when.at(-1) };
  }),
});

/** AI の代用品。呼び出しの種類ごとに、決めた答えを（出力のスキーマを通して）返す */
export function fakeAi(answers: {
  interpret?: unknown;
  /** 修正（revise）の読み取り */
  revise?: unknown;
  patch?: unknown;
  decide?: (data: DecideData) => unknown;
}) {
  const calls: AiCall<unknown>[] = [];
  const ai: Ai = {
    async callTool<T>(call: AiCall<T>): Promise<T> {
      calls.push(call);
      const answer =
        call.operation === 'interpret'
          ? (answers.interpret ?? intent())
          : call.operation === 'patch'
            ? answers.patch
            : call.operation === 'revise'
              ? answers.revise
              : (answers.decide ?? decide)(call.data as DecideData);
      if (answer instanceof Error) throw answer;
      return call.schema.parse(answer);
    },
  };
  return { ai, calls };
}

export const allDay = [{ open: at('00:00'), close: at('00:00', '2026-11-28') }];
/** Google Maps の代用品。場所の確定（fields=basic）は places、店の検索は stores から返す */
export function fakeMaps(
  options: {
    places?: Record<string, Place[]>;
    stores?: (search: PlaceSearch) => Place[] | Error;
  } = {},
) {
  const searches: PlaceSearch[] = [];
  const maps = {
    async searchPlaces(search: PlaceSearch) {
      searches.push(search);
      if (search.fields === 'basic') {
        return (
          options.places?.[search.query] ?? [
            { placeId: `p-${search.query}`, name: search.query, location: TOKYO },
          ]
        );
      }
      const near = search.near ?? HOME;
      const result = options.stores?.(search) ?? [
        {
          placeId: `store-${near.lat}`,
          name: `サンプルスーパー${near.lat === HOME.lat ? '自宅前' : '駅前'}店`,
          location: { lat: near.lat + 0.001, lng: near.lng },
          openingPeriods: allDay,
        },
      ];
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as GoogleMapsClient;
  return { maps, searches };
}

export const travel: Travel = async (request) => ({
  mode: request.mode,
  minutes: request.mode === 'train' ? 30 : 10,
  steps: [],
  stations: request.mode === 'train' ? ['三軒茶屋', '東京'] : [],
});

/** 乗換案内の代用品：どの区間も 30 分の電車。到着の指定ならその時刻に着く便、出発の指定ならその時刻に出る便 */
export const fakeNavitime = {
  async searchTransitRoutes({ arriveBy, departAt }: TransitRouteRequest) {
    const iso = (date: Date) => new Date(date.getTime() + 9 * 3600_000).toISOString().slice(0, 19);
    const arrival = arriveBy ?? new Date((departAt ?? NOW).getTime() + 30 * 60_000);
    const departure = new Date(arrival.getTime() - 30 * 60_000);
    const times = {
      departureTime: `${iso(departure)}+09:00`,
      arrivalTime: `${iso(arrival)}+09:00`,
    };
    return [
      {
        ...times,
        durationMinutes: 30,
        transferCount: 0,
        walkDistanceMeters: 0,
        sections: [
          { kind: 'point', name: '三軒茶屋', location: HOME, stationCode: '1' },
          {
            kind: 'move',
            mode: 'local_train',
            lineName: 'サンプル線',
            durationMinutes: 30,
            ...times,
          },
          { kind: 'point', name: '東京', location: TOKYO, stationCode: '2' },
        ],
      },
    ];
  },
} as unknown as NavitimeClient;
