/**
 * 行動計画の組み立て。用事・立寄り（店は選択済み）と移動の結果から、時刻つきの行動項目を作る。
 *
 * - 時刻と行動項目は、すべてここ（プログラム）が決める。AI の出力は使わない
 * - 外部 API は直接呼ばない。移動は、渡された travel（lookup.ts の createTravel）で取得する
 * - 外出＝自宅を出てから自宅に戻るまで。区間＝外出の中の1つの移動（自宅→用事、用事→用事、用事→自宅）
 * - 区間の中は「出発地 →（出発地側の立寄り）→ 主な移動 →（到着地側の立寄り）→ 到着地」
 * - うまくいかない区間（出発が過去・時間が足りない・店が営業時間外など）の取り直しは、全体で1巡だけ
 */
import {
  distanceMeters,
  isOpenDuring,
  type LatLng,
  type OpeningPeriod,
} from '../adapters/google-maps.js';
import type { SlotType } from './slots.js';
import { atJst, jstDate, jstTime as hhmm, MINUTE } from './time.js';

export type Mode = 'train' | 'walk' | 'bicycle' | 'car';
/** 利用者の優先条件 */
export type Priority = 'on_time' | 'save_money' | 'points';

export interface TravelRequest {
  from: LatLng;
  to: LatLng;
  mode: Mode;
  /** どちらも無ければ、所要時間だけを求める */
  departAt?: Date;
  arriveBy?: Date;
  /** 外部 API を呼ばず、直線距離からの概算で返す（残り時間が無いとき） */
  offline?: boolean;
}

/** API 仕様（openapi.yaml）の RouteStep と同じ形 */
export interface RouteStep {
  instruction: string;
  transportMode: Mode;
  lineName?: string;
  fromStation?: string;
  toStation?: string;
  departureTime?: string;
  arrivalTime?: string;
  distanceMeters?: number;
  durationMinutes?: number;
}

/** 1つの移動。時刻表のある移動（電車）だけ、departure・arrival を持つ */
export interface Leg {
  mode: Mode;
  minutes: number;
  departure?: Date;
  arrival?: Date;
  distanceMeters?: number;
  fareYen?: number;
  polyline?: string;
  steps: RouteStep[];
  /** 降りる駅の出口・乗車位置（乗換案内の結果にあるときだけ） */
  stationExit?: string;
  boardingPosition?: string;
  /** 経路に出てくる駅名（AI の文に書かれた駅名の照合に使う） */
  stations?: string[];
  /** 経路を取得できず、直線距離からの概算で置いた */
  approximate?: boolean;
}

/** 移動を取得する。失敗しても例外にせず、概算（approximate）で返す */
export type Travel = (request: TravelRequest) => Promise<Leg>;

export interface Store {
  placeId: string;
  name: string;
  address?: string;
  location: LatLng;
  openingPeriods?: OpeningPeriod[];
  pointProgramCode?: string;
}

export interface ComposeErrand {
  id: string;
  title: string;
  kind: 'meal' | 'party' | 'other';
  /** place＝その場所へ行く／home＝自宅で迎える／stay＝直前の用事の場所にとどまる */
  at: 'place' | 'home' | 'stay';
  /** 確定した場所（at=place のとき） */
  name?: string;
  location?: LatLng;
  start: Date;
  end: Date;
}

export interface ComposeStop {
  id: string;
  category: string;
  /** 置く場所：home、または用事の ID（計画に無い用事の ID は、home として扱う） */
  anchor: string;
  when: 'before' | 'after';
  /** 店の候補。先頭が選んだ店で、残りは営業時間外だったときの替え */
  options: Store[];
}

export interface ComposeInput {
  now: Date;
  /** 対象日（YYYY-MM-DD、日本時間） */
  date: string;
  home: LatLng;
  mode: Mode;
  errands: ComposeErrand[];
  stops: ComposeStop[];
  /** 「いったん帰宅する」を選んだ空き（前の用事の ID。stay の用事の ID でもよい） */
  homeBetween: string[];
  /** 買い物だけのときの、出かける時刻（HH:mm） */
  shoppingTime?: string;
  preparationMinutes: number;
  priority: Priority;
  /** 取り直しに使える時間が残っているか。false なら、取り直しは概算で行う */
  canRetry?: () => boolean;
}

export interface ComposedItem {
  slotType: SlotType;
  itemType: 'departure' | 'move' | 'stopover' | 'errand' | 'meal' | 'return';
  title: string;
  start: Date;
  end: Date;
  locationName?: string;
  location?: LatLng;
  transportMode?: Mode;
  route?: Pick<Leg, 'distanceMeters' | 'fareYen' | 'polyline' | 'steps'> & {
    durationMinutes: number;
  };
  store?: Omit<Store, 'location' | 'openingPeriods'>;
  stationExit?: string;
  boardingPosition?: string;
  description?: string;
  /** 元になった用事・立寄りの ID */
  sourceId?: string;
}

export interface Composed {
  items: ComposedItem[];
  /** 最初の出発と最後の帰宅（外出が無ければ undefined） */
  departure?: Date;
  return?: Date;
  warnings: string[];
  assumptions: string[];
  /** 計画に入れられなかった立寄り。候補が無くて外したものは、注意に入れていない（呼び出し側が入れる） */
  droppedStopIds: string[];
  stations: string[];
}

export const MODE_LABEL: Record<Mode, string> = {
  train: '電車',
  walk: '徒歩',
  bicycle: '自転車',
  car: '車',
};
/** 立寄りの滞在時間（分） */
const dwellOf = (category: string) => (category === 'restaurant' ? 60 : 30);
/** 用事の開始より、どれだけ前に着くか（分） */
const marginOf = (input: ComposeInput) => (input.priority === 'on_time' ? 10 : 5);

const add = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE);
const minutesBetween = (from: Date, to: Date) =>
  Math.ceil((to.getTime() - from.getTime()) / MINUTE);
const clip = (value: string, max: number) => [...value].slice(0, max).join('');
const byStart = (a: { start: Date }, b: { start: Date }) => a.start.getTime() - b.start.getTime();

/** 場所へ行く用事と、その場所でそのまま迎える用事（stay）のまとまり */
interface Visit {
  errand: ComposeErrand;
  /** まとめた用事の ID（stay を含む） */
  ids: string[];
  location: LatLng;
  /** その場所を出られる時刻 */
  end: Date;
}

interface Point {
  id: string;
  name: string;
  location: LatLng;
  /** 滞在時間（立寄りだけ） */
  dwell: number;
  stop?: ComposeStop;
  store?: Store;
}

interface Segment {
  /** 出発地と到着地（取り直しの指定に使う） */
  base: string;
  /** 中身が同じなら同じ値（取り直しの要否の判定に使う） */
  key: string;
  points: Point[];
  /** 時刻に合わせて探す「主な移動」の番号。それ以外は、近くの移動（徒歩など） */
  main: number;
  arriveBy?: Date;
  departAt?: Date;
  /** 出発地・到着地の用事（自宅なら undefined） */
  source?: Visit;
  target?: Visit;
  /** 最初の外出の最初の区間／最後の外出の最後の区間 */
  first: boolean;
  last: boolean;
}

interface Routed {
  seg: Segment;
  legs: Leg[];
  /** 移動ごとの出発・到着 */
  dep: Date[];
  arr: Date[];
  start: Date;
  end: Date;
}

/** 取り直しのたびに変わる部分 */
interface State {
  homeBetween: Set<string>;
  dropped: Set<string>;
  /** 立寄りごとの、使う店の番号 */
  pick: Map<string, number>;
  /** 「出られる時刻にすぐ出る」に切り替えた区間（base） */
  hurry: Set<string>;
  notes: string[];
}

type Places = Map<string, { name: string; location: LatLng }>;

/** 外出と区間に分ける。places は、用事ごとの迎える場所 */
function outline(input: ComposeInput, state: State, shoppingStart: Date) {
  const home: Point = { id: 'home', name: '自宅', location: input.home, dwell: 0 };
  const places: Places = new Map();
  const outings: Visit[][] = [];
  let current: Visit[] = [];
  const close = () => {
    if (current.length > 0) outings.push(current);
    current = [];
  };
  for (const errand of [...input.errands].sort(byStart)) {
    const previous = current.at(-1);
    if (errand.at === 'place' && errand.location) {
      if (previous?.ids.some((id) => state.homeBetween.has(id))) close();
      current.push({ errand, ids: [errand.id], location: errand.location, end: errand.end });
      places.set(errand.id, { name: errand.name ?? errand.title, location: errand.location });
    } else if (errand.at === 'stay' && previous) {
      previous.ids.push(errand.id);
      if (errand.end > previous.end) previous.end = errand.end;
      places.set(errand.id, places.get(previous.errand.id) ?? home);
    } else {
      // 自宅で迎える用事（外出先の用事が前に無い stay も同じ）は、外出を区切る。
      // その前の「いったん帰宅する」は、意味が無いので消す
      previous?.ids.forEach((id) => state.homeBetween.delete(id));
      close();
      places.set(errand.id, home);
    }
  }
  close();

  const visited = new Set(outings.flat().flatMap((v) => v.ids));
  const shopping = outings.length === 0;
  /** 条件に合う立寄りを、near に近い順に並べる */
  const side = (test: (stop: ComposeStop) => boolean, near: LatLng): Point[] =>
    input.stops
      .filter((s) => !state.dropped.has(s.id) && test(s))
      .flatMap((stop) => {
        const store = stop.options[state.pick.get(stop.id) ?? 0];
        const dwell = dwellOf(stop.category);
        return store
          ? [{ id: stop.id, name: store.name, location: store.location, dwell, stop, store }]
          : [];
      })
      .sort((a, b) => distanceMeters(a.location, near) - distanceMeters(b.location, near));
  /** 置く場所が、その用事（自宅なら、自宅または計画に無い用事）か */
  const anchored = (stop: ComposeStop, visit?: Visit) =>
    visit ? visit.ids.includes(stop.anchor) : !visited.has(stop.anchor);

  const segments: Segment[] = [];
  const segment = (
    from: Visit | undefined,
    to: Visit | undefined,
    first: boolean,
    last: boolean,
  ) => {
    const base = `${from?.errand.id ?? 'home'}>${to?.errand.id ?? 'home'}`;
    const hurry = state.hurry.has(base);
    // 出発地側の立寄り（近い順）と、到着地側の立寄り（到着地に近いものを最後に）
    const near = hurry
      ? []
      : side(
          (s) =>
            anchored(s, from) &&
            (from ? s.when === 'after' : first && (shopping || s.when === 'before')),
          from?.location ?? input.home,
        );
    const far =
      hurry || shopping
        ? []
        : side(
            (s) => anchored(s, to) && (to ? s.when === 'before' : last && s.when === 'after'),
            to?.location ?? input.home,
          ).reverse();
    const point = (v?: Visit): Point =>
      v ? { id: v.errand.id, ...places.get(v.errand.id)!, dwell: 0 } : home;
    const time: Pick<Segment, 'arriveBy' | 'departAt'> = hurry
      ? { departAt: from ? from.end : add(input.now, input.preparationMinutes) }
      : to
        ? { arriveBy: add(to.errand.start, -marginOf(input)) }
        : { departAt: from ? from.end : shoppingStart };
    const points = [point(from), ...near, ...far, point(to)];
    const when = time.arriveBy
      ? `A${time.arriveBy.toISOString()}`
      : `D${time.departAt?.toISOString()}`;
    segments.push({
      base,
      key: [base, ...points.map((p) => p.store?.placeId ?? p.id), when].join('|'),
      points,
      // 買い物だけの外出は、すべて近くの移動
      main: shopping ? -1 : near.length,
      ...time,
      source: from,
      target: to,
      first,
      last,
    });
  };

  if (shopping && side(() => true, input.home).length > 0)
    segment(undefined, undefined, true, true);
  outings.forEach((visits, outing) => {
    const ends = [undefined, ...visits, undefined];
    visits.forEach((_, i) => segment(ends[i], ends[i + 1], outing === 0 && i === 0, false));
    segment(visits.at(-1), undefined, false, outing === outings.length - 1);
  });
  return { segments, places };
}

/** 区間の移動を取得し、時刻を置く。到着の指定があれば逆算、出発の指定があれば順に計算する */
async function route(seg: Segment, mode: Mode, travel: Travel, offline: boolean): Promise<Routed> {
  const { points } = seg;
  const count = points.length - 1;
  const request = (i: number, time: Pick<TravelRequest, 'arriveBy' | 'departAt'> = {}) =>
    travel({
      from: points[i]!.location,
      to: points[i + 1]!.location,
      mode: i === seg.main || mode !== 'train' ? mode : 'walk',
      offline,
      ...time,
    });
  // 近くの移動は時刻によらないので、先にまとめて取得する
  const pending = Array.from({ length: count }, (_, i) =>
    i === seg.main ? undefined : request(i),
  );
  const legs: Leg[] = [];
  const dep: Date[] = [];
  const arr: Date[] = [];
  if (seg.arriveBy) {
    let cursor = seg.arriveBy;
    for (let i = count - 1; i >= 0; i--) {
      const leg = (legs[i] = await (pending[i] ?? request(i, { arriveBy: cursor })));
      arr[i] = leg.arrival ?? cursor;
      dep[i] = leg.departure ?? add(arr[i]!, -leg.minutes);
      cursor = add(dep[i]!, -points[i]!.dwell);
    }
  } else if (seg.departAt) {
    let cursor = seg.departAt;
    for (let i = 0; i < count; i++) {
      const leg = (legs[i] = await (pending[i] ?? request(i, { departAt: cursor })));
      dep[i] = leg.departure ?? cursor;
      arr[i] = leg.arrival ?? add(dep[i]!, leg.minutes);
      cursor = add(arr[i]!, points[i + 1]!.dwell);
    }
  }
  return { seg, legs, dep, arr, start: dep[0]!, end: arr[count - 1]! };
}

/**
 * 取得した区間を確かめる。直せる問題は、fix=true のとき state を書き換える（呼び出し側が取り直す）。
 * 直せない問題・取り直したあとも残る問題は、注意の文にして返す
 */
function review(routed: Routed[], input: ComposeInput, state: State, fix: boolean) {
  const warnings: string[] = [];
  let changed = false;
  const drop = (points: Point[], reason: string) => {
    for (const point of points.filter((p) => p.stop)) {
      state.dropped.add(point.id);
      state.notes.push(`${reason}ため、「${point.name}」への立寄りを外しました`);
      changed = true;
    }
  };

  routed.forEach((r, index) => {
    const { seg } = r;
    const next = routed[index + 1];

    // 逆算した出発が、出られる時刻（自宅なら現在、用事ならその終了）より前：
    // 出られる時刻に出る経路に切り替え、立寄りを外す。取り直したあとも残れば注意
    const earliest = seg.source?.end ?? input.now;
    if (seg.arriveBy && r.start < earliest) {
      if (fix) {
        state.hurry.add(seg.base);
        drop(seg.points, seg.source ? '移動の時間が足りない' : '出発までの時間が足りない');
        changed = true;
        return;
      }
      warnings.push(
        `${seg.points[0]!.name}を出る時刻（${hhmm(r.start)}）に、約${minutesBetween(r.start, earliest)}分間に合いません`,
      );
    }
    if (!seg.source && r.start >= input.now && r.start < add(input.now, input.preparationMinutes)) {
      warnings.push(
        `出発まで約${minutesBetween(input.now, r.start)}分です。準備の時間が足りない可能性があります`,
      );
    }
    if (seg.target && r.end > seg.target.errand.start) {
      warnings.push(
        `「${seg.target.errand.title}」に、約${minutesBetween(seg.target.errand.start, r.end)}分遅れる見込みです`,
      );
      // 遅れの波及（再計算はしない）
      if (next?.seg.source?.errand.id === seg.target.errand.id && r.end > next.start) {
        warnings.push('遅れにより、そのあとの予定にも影響が出る可能性があります');
      }
    }
    // 営業時間（確定した時刻で、滞在の間ずっと）：次の候補に替える。無ければ外す
    seg.points.forEach((point, i) => {
      if (!point.stop || !point.store) return;
      const from = seg.arriveBy ? add(r.dep[i]!, -point.dwell) : r.arr[i - 1]!;
      const open = (store: Store) => isOpenDuring(store, from, add(from, point.dwell)) === true;
      if (open(point.store)) return;
      if (!fix) {
        warnings.push(
          `「${point.name}」は、到着する時刻（${hhmm(from)}）に営業していない可能性があります`,
        );
        return;
      }
      const current = state.pick.get(point.id) ?? 0;
      const replacement = point.stop.options.findIndex((o, k) => k > current && open(o));
      if (replacement < 0) return drop([point], '到着する時刻に営業していない');
      state.pick.set(point.id, replacement);
      changed = true;
    });
    if (r.legs.some((leg) => leg.approximate)) {
      warnings.push(
        `${seg.points[0]!.name}から${seg.points.at(-1)!.name}までの経路を取得できませんでした（概算の時刻です）`,
      );
    }
    // 「いったん帰宅する」で、自宅にいられる時間が無い：「外で過ごす」に戻す。
    // 戻したあとの確認はできない（取り直しは1巡）ので、前後の立寄りは外す
    if (
      fix &&
      seg.source?.ids.some((id) => state.homeBetween.has(id)) &&
      !seg.target &&
      next?.seg.target &&
      !next.seg.source &&
      r.end >= next.start
    ) {
      seg.source.ids.forEach((id) => state.homeBetween.delete(id));
      state.notes.push(
        `「${seg.source.errand.title}」のあとは、帰宅する時間が取れないため、外で過ごす計画にしました`,
      );
      drop([...seg.points, ...next.seg.points], '移動の時間が足りない');
      changed = true;
    }
  });
  return { warnings, changed };
}

/** 行動項目にする */
function toItems(routed: Routed[], input: ComposeInput, places: Places): ComposedItem[] {
  const items: ComposedItem[] = input.errands.map((errand) => ({
    slotType: 'MAIN',
    itemType: errand.kind === 'meal' ? 'meal' : 'errand',
    title: clip(errand.title, 100),
    start: errand.start,
    end: errand.end,
    locationName: places.get(errand.id)?.name,
    location: places.get(errand.id)?.location,
    sourceId: errand.id,
  }));
  const atHome = (
    itemType: 'departure' | 'return',
    slotType: SlotType,
    time: Date,
    description?: string,
  ): ComposedItem => ({
    slotType,
    itemType,
    title: itemType === 'departure' ? '自宅を出発' : '帰宅',
    start: time,
    end: time,
    locationName: '自宅',
    location: input.home,
    description,
  });
  for (const r of routed) {
    const { seg, legs } = r;
    /** 買い物だけの外出（最初で最後の区間）は、最後の移動だけを復路にする */
    const slotOf = (i: number): SlotType =>
      seg.last && (!seg.first || i === legs.length - 1)
        ? 'RETURN'
        : seg.first
          ? 'OUTBOUND'
          : 'MAIN';
    if (!seg.source) {
      const prepare = `準備開始の目安 ${hhmm(add(r.start, -input.preparationMinutes))}`;
      items.push(
        atHome(
          'departure',
          seg.first ? 'DEPARTURE' : 'MAIN',
          r.start,
          seg.first ? prepare : undefined,
        ),
      );
    }
    legs.forEach((leg, i) => {
      const point = seg.points[i + 1]!;
      if (leg.minutes > 0) {
        const { distanceMeters, fareYen, polyline, steps } = leg;
        items.push({
          slotType: slotOf(i),
          itemType: 'move',
          title: `${MODE_LABEL[leg.mode]}で${clip(point.name, 80)}へ`,
          start: r.dep[i]!,
          end: r.arr[i]!,
          locationName: point.name,
          location: point.location,
          transportMode: leg.mode,
          route: { distanceMeters, durationMinutes: leg.minutes, fareYen, polyline, steps },
          stationExit: leg.stationExit,
          boardingPosition: leg.boardingPosition,
          description: leg.approximate ? '経路を取得できなかったため、概算の時刻です' : undefined,
        });
      }
      if (point.stop && point.store) {
        const { placeId, name, address, pointProgramCode } = point.store;
        items.push({
          slotType: slotOf(i),
          itemType: point.stop.category === 'restaurant' ? 'meal' : 'stopover',
          title: clip(name, 100),
          start: r.arr[i]!,
          end: r.dep[i + 1]!,
          locationName: name,
          location: point.location,
          store: { placeId, name, address, pointProgramCode },
          sourceId: point.id,
        });
      }
    });
    if (!seg.target) items.push(atHome('return', seg.last ? 'RETURN' : 'MAIN', r.end));
  }
  // 開始の順に並べる。同じ時刻なら、帰宅 → 用事 → 出発・移動
  const rank = (item: ComposedItem) => (item.itemType === 'return' ? 0 : item.sourceId ? 1 : 2);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => byStart(a.item, b.item) || rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** 買い物だけの外出の出発：指定の時刻。無ければ（過ぎていれば）、今日は「現在＋準備時間」、明日は 10:00 */
export function shoppingStartOf(
  input: Pick<ComposeInput, 'now' | 'date' | 'shoppingTime' | 'preparationMinutes'>,
): Date {
  const given = input.shoppingTime && new Date(atJst(input.date, input.shoppingTime));
  if (given && given >= input.now) return given;
  return jstDate(input.now) === input.date
    ? add(input.now, input.preparationMinutes)
    : new Date(atJst(input.date, '10:00'));
}

export async function composePlan(input: ComposeInput, travel: Travel): Promise<Composed> {
  const state: State = {
    homeBetween: new Set(input.homeBetween),
    dropped: new Set(input.stops.filter((s) => s.options.length === 0).map((s) => s.id)),
    pick: new Map(),
    hurry: new Set(),
    notes: [],
  };
  const warnings: string[] = [];

  const shoppingStart = shoppingStartOf(input);

  let plan = outline(input, state, shoppingStart);
  let routed = await Promise.all(plan.segments.map((s) => route(s, input.mode, travel, false)));
  let result = review(routed, input, state, true);
  if (result.changed) {
    // 取り直しは1巡だけ。中身の変わった区間だけを取り直す（時間が残っていなければ、概算で）
    const done = new Map(routed.map((r) => [r.seg.key, r]));
    const offline = input.canRetry?.() === false;
    plan = outline(input, state, shoppingStart);
    routed = await Promise.all(
      plan.segments.map(async (seg) => {
        const same = done.get(seg.key);
        return same ? { ...same, seg } : route(seg, input.mode, travel, offline);
      }),
    );
    result = review(routed, input, state, false);
  }

  // 用事どうしの重なり（それまでで最も遅く終わる用事と比べる）
  let latest: ComposeErrand | undefined;
  for (const errand of [...input.errands].sort(byStart)) {
    if (latest && errand.start < latest.end) {
      warnings.push(`「${latest.title}」と「${errand.title}」の時間が重なっています`);
    }
    if (!latest || errand.end > latest.end) latest = errand;
  }
  // 自宅で迎える用事と、外出（出発から帰宅まで）の重なり
  let left: Date | undefined;
  for (const r of routed) {
    if (!r.seg.source) left = r.start;
    if (r.seg.target || !left) continue;
    for (const errand of input.errands) {
      if (
        plan.places.get(errand.id)?.name === '自宅' &&
        left < errand.end &&
        errand.start < r.end
      ) {
        warnings.push(`「${errand.title}」の時間に、外出が重なっています`);
      }
    }
  }

  const shoppingOnly = plan.segments.some((s) => !s.source && !s.target);
  return {
    items: toItems(routed, input, plan.places),
    departure: routed[0]?.start,
    return: routed.at(-1)?.end,
    warnings: [...new Set([...state.notes, ...warnings, ...result.warnings])],
    assumptions:
      shoppingOnly && hhmm(shoppingStart) !== input.shoppingTime
        ? [`出発を ${hhmm(shoppingStart)} と仮定しました`]
        : [],
    droppedStopIds: [...state.dropped],
    stations: [...new Set(routed.flatMap((r) => r.legs.flatMap((leg) => leg.stations ?? [])))],
  };
}
