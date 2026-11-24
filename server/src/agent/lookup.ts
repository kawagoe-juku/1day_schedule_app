/**
 * 計画生成で使う検索：場所の確定・店舗の候補・移動。
 * 外部 API（Google Maps・NAVITIME）の結果を、組み立て（compose.ts）が使う形にそろえる。
 * 駅・出口・店の名称は、外部 API の結果だけから作る。
 */
import type { PointProgramCode } from '../db/repositories/point-program-repository.js';
import {
  distanceMeters,
  isOpenAt,
  type GoogleMapsClient,
  type LatLng,
} from '../adapters/google-maps.js';
import { ExternalApiError } from '../adapters/http.js';
import type { NavitimeClient, TransitRoute } from '../adapters/navitime.js';
import {
  MODE_LABEL,
  type Leg,
  type Mode,
  type RouteStep,
  type Store,
  type Travel,
} from './compose.js';
import { pointProgramOf } from './point-chains.js';

export type Spot = Omit<Store, 'openingPeriods' | 'pointProgramCode'>;

/** 場所を探す（用事の場所の確定と、場所の候補）。near に近い順ではなく、Google の順のまま返す */
export async function findPlaces(
  maps: GoogleMapsClient,
  query: string,
  near: LatLng,
  limit = 5,
): Promise<Spot[]> {
  const places = await maps.searchPlaces({
    query,
    near,
    radiusMeters: 5000,
    maxResults: limit,
    fields: 'basic',
  });
  return places.flatMap(({ placeId, name, address, location }) =>
    location && name ? [{ placeId, name, address, location }] : [],
  );
}

// ---- 店舗の候補

const CATEGORY_QUERY: Record<string, string> = {
  supermarket: 'スーパー',
  drugstore: 'ドラッグストア',
  convenience: 'コンビニ',
  home_center: 'ホームセンター',
  bakery: 'パン屋',
  restaurant: 'レストラン',
};
const STORE_RADIUS_METERS = 1000;
const STORES_PER_ANCHOR = 3;

/** 立寄りを置ける場所。before・after は、その場所に寄る時刻の目安（営業時間の判定に使う） */
export interface StoreAnchor {
  /** home、または用事の ID */
  id: string;
  location: LatLng;
  before?: Date;
  after?: Date;
}

export interface StoreCandidate {
  stopId: string;
  /** 立寄りの中での番号（c1, c2…）。AI にはこの番号で選ばせる */
  candidate: string;
  anchor: string;
  /** 選べる置き方（その時刻に営業しているもの） */
  when: ('before' | 'after')[];
  distanceMeters: number;
  store: Store;
}

export interface StoreSearchOptions {
  /** 有効にしているポイント */
  programs: readonly PointProgramCode[];
  /** ポイント優先：対象の店があれば、その中からだけ選ぶ */
  pointsFirst: boolean;
}

/**
 * 立寄りごとに、置ける場所の近く（1km 以内）の店を探す。場所ごとに近い順で3件まで。
 * 営業時間が分からない店・その時刻に営業していない店は候補にしない。
 * 検索に失敗した立寄りは failedStopIds に入れる（計画は、立寄りなしで続ける）
 */
export async function findStores(
  maps: GoogleMapsClient,
  stops: readonly { id: string; category: string; chain?: string | null }[],
  anchors: readonly StoreAnchor[],
  options: StoreSearchOptions,
): Promise<{ candidates: StoreCandidate[]; failedStopIds: string[] }> {
  const failedStopIds: string[] = [];
  const perStop = await Promise.all(
    stops.map(async (stop) => {
      const query = [stop.chain, CATEGORY_QUERY[stop.category]].filter(Boolean).join(' ');
      if (!query) return [];
      const results = await Promise.allSettled(
        anchors.map((anchor) =>
          maps.searchPlaces({
            query,
            near: anchor.location,
            radiusMeters: STORE_RADIUS_METERS,
            maxResults: 10,
          }),
        ),
      );
      if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
        failedStopIds.push(stop.id);
      }

      const found = results.flatMap((result, index) => {
        const anchor = anchors[index]!;
        if (result.status === 'rejected') return [];
        return result.value.flatMap((place) => {
          if (!place.location || !place.name) return [];
          const distance = distanceMeters(anchor.location, place.location);
          const when = (['before', 'after'] as const).filter((w) => {
            const at = anchor[w];
            return at !== undefined && isOpenAt(place, at) === true;
          });
          if (distance > STORE_RADIUS_METERS || when.length === 0) return [];
          const store: Store = {
            placeId: place.placeId,
            name: place.name,
            address: place.address,
            location: place.location,
            openingPeriods: place.openingPeriods,
            pointProgramCode: pointProgramOf(place.name, options.programs),
          };
          return [{ anchor: anchor.id, when, distanceMeters: Math.round(distance), store }];
        });
      });
      const targets = found.filter((c) => c.store.pointProgramCode);
      const pool = options.pointsFirst && targets.length > 0 ? targets : found;
      return anchors
        .flatMap((anchor) =>
          pool
            .filter((c) => c.anchor === anchor.id)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, STORES_PER_ANCHOR),
        )
        .map((c, index) => ({ stopId: stop.id, candidate: `c${index + 1}`, ...c }));
    }),
  );
  return { candidates: perStop.flat(), failedStopIds };
}

// ---- 移動

const WALK_KMH = { slow: 3.6, normal: 4.8, fast: 6.0 };
/** 道のりは直線より長いので、概算では直線距離を割り増す */
const DETOUR = 1.3;
/** 電車・徒歩の計画で、これより近ければ、経路を探さず徒歩の概算にする */
const NEARBY_METERS = 300;
/** 乗換の経路が取れないとき、これより近ければ徒歩の経路にする */
const WALKABLE_METERS = 1500;
const ROUGH_KMH = { train: 30, car: 30, bicycle: 12 };

/** 外部 API の失敗は「取れなかった」として扱う（プログラムの誤りは、そのまま例外にする） */
const unavailable = (error: unknown) => {
  if (error instanceof ExternalApiError) return undefined;
  throw error;
};

export interface TravelOptions {
  walkingSpeed: keyof typeof WALK_KMH;
  priority: 'on_time' | 'save_money' | 'points';
}

const simpleStep = (mode: Mode, minutes: number, distance?: number): RouteStep[] => [
  {
    instruction: `${MODE_LABEL[mode]}（約${minutes}分）`,
    transportMode: mode,
    durationMinutes: minutes,
    distanceMeters: distance,
  },
];

/** 電車と徒歩だけの経路か（バス・飛行機・フェリーを含む経路は使わない） */
const isRailOnly = (route: TransitRoute) =>
  route.sections.every((s) => s.kind !== 'move' || s.mode === 'walk' || s.mode.includes('train'));

function fromTransit(route: TransitRoute): Leg {
  const { sections } = route;
  const steps: RouteStep[] = sections.flatMap((section, index) => {
    if (section.kind !== 'move') return [];
    const before = sections[index - 1];
    const after = sections[index + 1];
    const station = (s: typeof before) =>
      s?.kind === 'point' && s.stationCode ? s.name : undefined;
    const train = section.mode !== 'walk';
    return [
      {
        instruction: train
          ? [section.lineName, section.direction && `${section.direction}方面`]
              .filter(Boolean)
              .join(' ')
          : '徒歩',
        transportMode: train ? ('train' as const) : ('walk' as const),
        lineName: train ? section.lineName : undefined,
        fromStation: station(before),
        toStation: station(after),
        departureTime: section.departureTime,
        arrivalTime: section.arrivalTime,
        distanceMeters: section.distanceMeters,
        durationMinutes: section.durationMinutes,
      },
    ];
  });
  const stationPoints = sections.flatMap((s) => (s.kind === 'point' && s.stationCode ? [s] : []));
  const trains = sections.flatMap((s) => (s.kind === 'move' && s.mode !== 'walk' ? [s] : []));
  const distance = steps.reduce((sum, step) => sum + (step.distanceMeters ?? 0), 0);
  return {
    mode: trains.length > 0 ? 'train' : 'walk',
    minutes: route.durationMinutes,
    departure: new Date(route.departureTime),
    arrival: new Date(route.arrivalTime),
    distanceMeters: distance || undefined,
    fareYen: route.fare?.icYen,
    steps,
    stationExit: stationPoints.at(-1)?.gateway,
    boardingPosition: trains.find((t) => t.boardingPosition)?.boardingPosition,
    stations: stationPoints.map((s) => s.name),
  };
}

/**
 * 移動を取得する関数を作る。電車は NAVITIME、徒歩・自転車・車は Google を使う。
 * 経路が取れないとき・外部 API が失敗したときは、例外にせず、徒歩の経路か直線距離からの概算で返す
 */
export function createTravel(
  clients: { googleMaps?: GoogleMapsClient; navitime?: NavitimeClient },
  options: TravelOptions,
): Travel {
  const walkKmh = WALK_KMH[options.walkingSpeed];
  const rough = (mode: Mode, distance: number, approximate: boolean): Leg => {
    const kmh = mode === 'walk' ? walkKmh : ROUGH_KMH[mode];
    const minutes =
      Math.ceil((distance * DETOUR) / 1000 / (kmh / 60)) + (mode === 'train' ? 10 : 0);
    return {
      mode,
      minutes,
      distanceMeters: Math.round(distance * DETOUR),
      steps: simpleStep(mode, minutes, Math.round(distance * DETOUR)),
      approximate: approximate || undefined,
    };
  };
  const byRoad = async (
    request: { from: LatLng; to: LatLng; departAt?: Date },
    mode: Exclude<Mode, 'train'>,
  ): Promise<Leg | undefined> => {
    const route = await clients.googleMaps
      ?.computeRoute({
        origin: request.from,
        destination: request.to,
        mode,
        departureTime: request.departAt,
      })
      .catch(unavailable);
    if (!route) return undefined;
    // Google の徒歩は標準の速さなので、利用者の歩く速さに合わせる
    const scale = mode === 'walk' ? WALK_KMH.normal / walkKmh : 1;
    const minutes = Math.ceil((route.durationSeconds * scale) / 60);
    return {
      mode,
      minutes,
      distanceMeters: route.distanceMeters,
      polyline: route.polyline,
      steps: simpleStep(mode, minutes, route.distanceMeters),
    };
  };

  return async (request) => {
    const distance = distanceMeters(request.from, request.to);
    // 近ければ、経路を探さず徒歩の概算にする（車・自転車は、乗り物を置いていけないので対象外）
    const onFoot = request.mode === 'train' || request.mode === 'walk';
    if (onFoot && distance <= NEARBY_METERS) return rough('walk', distance, false);
    if (request.offline) return rough(request.mode, distance, true);
    if (request.mode !== 'train') {
      return (await byRoad(request, request.mode)) ?? rough(request.mode, distance, true);
    }
    const routes = await clients.navitime
      ?.searchTransitRoutes({
        start: request.from,
        goal: request.to,
        arriveBy: request.arriveBy,
        departAt: request.arriveBy ? undefined : request.departAt,
        walkSpeedKmh: walkKmh,
        order: options.priority === 'save_money' ? 'fare' : 'time_optimized',
      })
      .catch(unavailable);
    const route = routes?.find(isRailOnly);
    if (route) return fromTransit(route);
    const walk = distance <= WALKABLE_METERS ? await byRoad(request, 'walk') : undefined;
    return walk ?? rough(distance <= WALKABLE_METERS ? 'walk' : 'train', distance, true);
  };
}
