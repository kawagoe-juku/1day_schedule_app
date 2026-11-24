/**
 * 計画の下書き（plan.draft）。途中経過と、作り直しに必要な情報を持つ。
 * ここにあるのは、下書きを書き換える規則だけ（外部 API も DB も呼ばない）：
 * 予定の仕分けとまとめ、予定の一覧、回答の反映、不足の判定と質問文、仮定での穴埋め、設定の変更での見直し。
 * 品目名・入力の原文・プロンプトは、下書きに入れない。
 */
import type { LatLng } from '../adapters/google-maps.js';
import { distanceMeters } from '../adapters/google-maps.js';
import { validationError } from '../errors.js';
import { cleanText } from './ai.js';
import type { Mode, Store } from './compose.js';
import type { PlanContext } from './context.js';
import type { Spot } from './lookup.js';
import type { ErrandPatch, Interpretation } from './prompts.js';
import type { SlotId } from './slots.js';

export const MAX_ERRANDS = 5;
export const MAX_STOPS = 5;
/** 質問（場所の候補を含む）の上限。予定の一覧は数えない */
export const MAX_QUESTIONS = 2;
/** 「いったん帰宅する」を選べる空きの長さ（分） */
export const GAP_MINUTES = 180;
/** 仮定で場所を決めるとき、自宅からこの距離までの結果を使う */
const ASSUME_WITHIN_METERS = 50_000;

type Missing = 'place' | 'start' | 'end';

/** その日の予定（カレンダー・ルーティン）。ref は c12（カレンダー）・r3（ルーティン）の形 */
export interface PlanEvent {
  ref: string;
  source: 'calendar' | 'routine';
  /** YYYY-MM-DD（日本時間） */
  date: string;
  title: string;
  place?: string;
  /** ISO 8601（日本時間） */
  start: string;
  end: string;
}

export interface DraftErrand {
  id: string;
  source: 'input' | 'calendar' | 'routine';
  /** 元の予定（PlanEvent.ref）。入力の用事にまとめた予定のときも入る */
  ref?: string;
  /** 予定をまとめる前の、入力の値（予定が使えなくなったときに戻す） */
  original?: Pick<DraftErrand, 'place' | 'specific' | 'start' | 'end'>;
  title: string;
  kind: 'meal' | 'party' | 'other';
  /** place＝その場所へ行く／home＝自宅で迎える／stay＝外出先で迎える */
  at: 'place' | 'home' | 'stay';
  /** 迎え方を、予定の一覧で選んでもらう（場所が空・オンラインの予定） */
  needsPlace?: boolean;
  /** 場所の文字列（入力・登録された値） */
  place?: string;
  /** 場所が固有の名称か（false なら、候補から選んでもらう） */
  specific: boolean;
  /** 検索で確定した場所 */
  spot?: Spot;
  start?: string;
  end?: string;
  /** 仮定で埋めた項目 */
  assumed: Missing[];
  selected: boolean;
}

export interface DraftStop {
  id: string;
  category: string;
  chain?: string;
  perishable: boolean;
  selected: boolean;
  /** 選んだ店（先頭）と替えの候補、置く場所 */
  options?: Store[];
  anchor?: string;
  when?: 'before' | 'after';
}

export interface Pending {
  kind: 'selection' | 'place' | 'question';
  question: string;
  errandId?: string;
  missing?: Missing[];
  /** 場所の候補（id は p1, p2…） */
  options?: (Spot & { id: string })[];
}

export interface Draft {
  /** 版数。保存のたびに +1。確認の番号と、同時更新の検出に使う */
  rev: number;
  /** ID の採番。消した ID は再利用しない */
  nextId: number;
  date: string;
  mode: Mode;
  errands: DraftErrand[];
  stops: DraftStop[];
  /** 「いったん帰宅する」を選んだ空き（前の用事の ID） */
  homeBetween: string[];
  shoppingTime?: string;
  /** 仮定の文（AI の読み取りと、不足を埋めたもの） */
  assumptions: string[];
  slots?: { slot: SlotId; decision: string }[];
  selectionDone: boolean;
  /** 作り始めたときに、カレンダーの予定を取得できなかった（注意に出す） */
  calendarFailed?: boolean;
  pending?: Pending;
}

const MINUTE = 60_000;
const jst = (date: Date) => new Date(date.getTime() + 9 * 3600_000).toISOString();
export const jstDate = (date: Date) => jst(date).slice(0, 10);
export const toIso = (date: Date) => `${jst(date).slice(0, 19)}+09:00`;
export const hhmm = (iso: string) => jst(new Date(iso)).slice(11, 16);
const plus = (iso: string, minutes: number) => toIso(new Date(Date.parse(iso) + minutes * MINUTE));
const clip = (value: string, max: number) => [...cleanText(value)].slice(0, max).join('');
// 「Meeting Room」「Teamsビル」のような実在の場所に当たらないよう、サービス名は絞って書く
const ONLINE =
  /https?:|www\.|zoom|microsoft teams|teams(会議|ミーティング)|^teams$|google meet|meet\.google|webex|オンライン|リモート|ウェブ会議|web会議/i;

/** 対象日の HH:mm を日時にする。after より前なら翌日（日をまたぐ用事の終了） */
function atTime(date: string, time: string, after?: string): string {
  const iso = `${date}T${time}:00+09:00`;
  return after && Date.parse(iso) <= Date.parse(after) ? plus(iso, 24 * 60) : iso;
}

/** 開始の順（開始の無いものは最後） */
const byStart = (a: DraftErrand, b: DraftErrand) =>
  (a.start ? Date.parse(a.start) : Infinity) - (b.start ? Date.parse(b.start) : Infinity);
export const selectedErrands = (draft: Draft) =>
  draft.errands.filter((e) => e.selected).sort(byStart);
export const selectedStops = (draft: Draft) => draft.stops.filter((s) => s.selected);
/** 一覧・質問で使う、仮の終了（終了が無ければ 60 分） */
const endOf = (errand: DraftErrand) => errand.end ?? (errand.start && plus(errand.start, 60));

/**
 * 読み取り（AI①）の結果と、その日の予定から、下書きを作る。
 * 入力と同じ予定（sameAs）は入力の用事にまとめ、残りの予定は用事として並べる
 */
export function createDraft(intent: Interpretation, events: PlanEvent[], now: Date): Draft {
  const date = jstDate(intent.date === 'tomorrow' ? new Date(now.getTime() + 24 * 3600_000) : now);
  const today = events.filter((e) => e.date === date);
  let nextId = 1;
  const merged = new Set<string>();

  const errands: DraftErrand[] = intent.errands.map((e) => {
    const start = e.startTime ? atTime(date, e.startTime) : undefined;
    const own = {
      place: e.place ?? undefined,
      specific: e.placeIsSpecific,
      start,
      end: e.endTime ? atTime(date, e.endTime, start) : undefined,
    };
    const event = today.find((x) => x.ref === e.sameAs && !merged.has(x.ref));
    if (event) merged.add(event.ref);
    // まとめるとき：時刻は予定のもの。場所は、入力が固有の名称ならそれ、そうでなければ予定のもの
    const eventPlace = event?.place && !ONLINE.test(event.place) ? event.place : undefined;
    const usesEventPlace = !(own.place && own.specific) && eventPlace !== undefined;
    return {
      id: `e${nextId++}`,
      source: 'input',
      title: e.title,
      kind: e.kind,
      at: 'place',
      ...own,
      ...(event && {
        ref: event.ref,
        original: own,
        start: event.start,
        end: event.end,
        ...(usesEventPlace && { place: eventPlace, specific: true }),
      }),
      assumed: [],
      selected: true,
    };
  });
  for (const event of today.filter((x) => !merged.has(x.ref))) {
    const needsPlace = !event.place || ONLINE.test(event.place);
    errands.push({
      id: `e${nextId++}`,
      source: event.source,
      ref: event.ref,
      title: clip(event.title, 40) || '予定',
      kind: 'other',
      at: needsPlace ? 'home' : 'place',
      ...(needsPlace ? { needsPlace } : { place: clip(event.place ?? '', 100) }),
      specific: true,
      start: event.start,
      end: event.end,
      assumed: [],
      // 当日の、すでに終わった予定は、初期値で選ばない
      selected: Date.parse(event.end) > now.getTime(),
    });
  }
  // 選べるのは5件まで（いま入力した用事を先に数え、残りを開始の早い順に）
  errands
    .filter((e) => e.selected)
    .sort((a, b) => Number(b.source === 'input') - Number(a.source === 'input') || byStart(a, b))
    .slice(MAX_ERRANDS)
    .forEach((e) => (e.selected = false));

  return {
    rev: 0,
    date,
    mode: intent.mode,
    errands,
    stops: intent.stops.map((s, index) => ({
      id: `s${nextId++}`,
      category: s.category,
      chain: s.chain ?? undefined,
      perishable: s.perishable,
      selected: index < MAX_STOPS,
    })),
    nextId,
    homeBetween: [],
    shoppingTime: intent.shoppingTime ?? undefined,
    assumptions: intent.assumptions,
    selectionDone: false,
  };
}

/** 予定の一覧を出すか：用事が2件以上／立寄りが6件以上／迎え方を選ぶ予定がある */
export const needsSelection = (draft: Draft) =>
  !draft.selectionDone &&
  (draft.errands.filter((e) => e.selected).length >= 2 ||
    draft.stops.length > MAX_STOPS ||
    draft.errands.some((e) => e.selected && e.needsPlace));

export interface SelectionAnswer {
  selectedIds: string[];
  places?: { id: string; at: 'home' | 'stay' | 'place'; text?: string }[];
  homeBetween?: string[];
}

/** 予定の一覧への回答を反映する。一覧に無い ID・件数の違反は 400 */
export function applySelection(draft: Draft, answer: SelectionAnswer): void {
  const fail = (field: string, message: string) => validationError([{ field, message }]);
  const known = new Set([...draft.errands, ...draft.stops].map((x) => x.id));
  const ids = new Set(answer.selectedIds);
  if ([...ids].some((id) => !known.has(id))) throw fail('selectedIds', '一覧に無い ID です');
  for (const item of [...draft.errands, ...draft.stops]) item.selected = ids.has(item.id);
  const errands = draft.errands.filter((e) => e.selected);
  if (errands.length > MAX_ERRANDS) {
    throw fail('selectedIds', `用事は${MAX_ERRANDS}件まで選べます`);
  }
  if (selectedStops(draft).length > MAX_STOPS) {
    throw fail('selectedIds', `立寄りは${MAX_STOPS}件まで選べます`);
  }
  if (ids.size === 0) throw fail('selectedIds', '用事か立寄りを1件以上選んでください');

  // 迎え方（指定が無ければ「自宅で」）
  const places = answer.places ?? [];
  if (places.some((p) => !draft.errands.some((e) => e.id === p.id && e.needsPlace))) {
    throw fail('places', '迎え方を選べない予定です');
  }
  for (const errand of draft.errands.filter((e) => e.needsPlace)) {
    const choice = places.find((p) => p.id === errand.id);
    if (choice?.at === 'place' && !choice.text?.trim()) {
      throw fail('places', '場所を入力してください');
    }
    errand.at = choice?.at ?? 'home';
    errand.place = choice?.at === 'place' ? clip(choice.text ?? '', 100) : undefined;
    delete errand.needsPlace;
  }
  // 空き（終了から次の開始まで3時間以上）だけを受け付ける。条件に合わない指定は無視する
  const sorted = [...errands].sort(byStart);
  draft.homeBetween = [...new Set(answer.homeBetween)].filter((id) => {
    const index = sorted.findIndex((e) => e.id === id);
    const end = sorted[index] && endOf(sorted[index]);
    const next = sorted[index + 1]?.start;
    return end && next && Date.parse(next) - Date.parse(end) >= GAP_MINUTES * MINUTE;
  });
  draft.selectionDone = true;
}

/**
 * 確認への自由入力（AI①の差分）を、用事に反映する。場所が変われば、確定した場所を捨てる。
 * 予定にまとめた用事では、戻すときの値（original）も同じように書き換える
 */
export function applyPatch(draft: Draft, errandId: string, patch: ErrandPatch): void {
  const errand = draft.errands.find((e) => e.id === errandId);
  if (!errand) return;
  const changes: Partial<DraftErrand> = {};
  if (patch.place && patch.place !== errand.place) {
    Object.assign(changes, { place: patch.place, specific: patch.placeIsSpecific });
    delete errand.spot;
    // 自宅のすぐ近くとして「自宅で迎える」にしていた用事も、検索し直す
    if (errand.at === 'home' && !errand.needsPlace) errand.at = 'place';
  }
  if (patch.startTime) changes.start = atTime(draft.date, patch.startTime);
  const start = changes.start ?? errand.start;
  // 変わっていない終了を AI がそのまま返すことがある。新しい開始より前なら、終了の指定なしとして扱う
  const echoed = patch.startTime && errand.end && patch.endTime === hhmm(errand.end);
  if (patch.endTime && start && !echoed) changes.end = atTime(draft.date, patch.endTime, start);
  Object.assign(errand, changes);
  if (errand.original) Object.assign(errand.original, changes);
  // 開始が終了より後になったら、終了は聞き直す
  if (errand.start && errand.end && Date.parse(errand.end) <= Date.parse(errand.start)) {
    delete errand.end;
  }
}

/** 場所の候補から選んだ回答を反映する。候補に無い ID は 400 */
export function applyPlaceChoice(draft: Draft, optionId: string, home: LatLng): void {
  const option = draft.pending?.options?.find((o) => o.id === optionId);
  const errand = draft.errands.find((e) => e.id === draft.pending?.errandId);
  if (!option || !errand) {
    throw validationError([{ field: 'selectedIds', message: '候補に無い ID です' }]);
  }
  const { placeId, name, address, location } = option;
  setSpot(errand, { placeId, name, address, location }, home);
}

/** 自宅から 100m 以内の場所は、自宅で迎える用事として扱う */
export function setSpot(errand: DraftErrand, spot: Spot, home: LatLng): void {
  errand.spot = spot;
  if (distanceMeters(home, spot.location) <= 100) errand.at = 'home';
}

/** 用事に足りない項目。当日の入力の用事で、開始が過ぎているものは、開始を聞き直す */
function missingOf(errand: DraftErrand, now: Date): Missing[] {
  const past =
    errand.source === 'input' &&
    !errand.assumed.includes('start') &&
    errand.start !== undefined &&
    Date.parse(errand.start) < now.getTime();
  return [
    errand.at === 'place' && !errand.spot && ('place' as const),
    (!errand.start || past) && ('start' as const),
    // 食事・飲み会の終了は、開始が分かれば既定の所要時間で決まるので、聞かない
    !errand.end && !DURATION[errand.kind] && ('end' as const),
  ].filter((m) => m !== false);
}

/** 所要時間の既定（分）：食事 60 分、飲み会 2 時間（それ以外は質問で聞く） */
const DURATION: Record<DraftErrand['kind'], number | undefined> = {
  meal: 60,
  party: 120,
  other: undefined,
};
function fillDefaults(draft: Draft): void {
  for (const errand of draft.errands) {
    const minutes = DURATION[errand.kind];
    if (errand.start && !errand.end && minutes) errand.end = plus(errand.start, minutes);
  }
}

const LABEL: Record<Missing, string> = {
  place: '場所',
  start: '開始の時刻',
  end: '何時ごろまでか',
};

/**
 * 次に確認すること（無ければ undefined）。不足のある用事を、開始の早い順に、1回に1件ずつ聞く。
 * candidates は、場所を1つに決められなかった用事の、検索の結果
 */
export function nextPending(
  draft: Draft,
  candidates: Map<string, Spot[]>,
  now: Date,
): Pending | undefined {
  fillDefaults(draft);
  for (const errand of selectedErrands(draft)) {
    const missing = missingOf(errand, now);
    if (missing.length === 0) continue;
    if (missing.includes('place') && errand.place) {
      const options = (candidates.get(errand.id) ?? []).map((s, i) => ({ id: `p${i + 1}`, ...s }));
      return {
        kind: 'place',
        errandId: errand.id,
        question: `「${errand.title}」の場所はどちらですか？`,
        options,
      };
    }
    const asked = missing.map((m) => LABEL[m]).join('と、');
    const past = errand.start && missing.includes('start');
    return {
      kind: 'question',
      errandId: errand.id,
      missing,
      question: past
        ? `「${errand.title}」の開始の時刻（${hhmm(errand.start ?? '')}）は過ぎています。${asked}を教えてください`
        : `「${errand.title}」について、${asked}を教えてください`,
    };
  }
  return undefined;
}

/**
 * 質問の上限に達したあと、残りの不足を仮定で埋める。場所が決まらない用事は外す。注意の文を返す。
 * 開始は「今日＝現在の2時間後を30分単位に切り上げ、明日＝10:00」、所要時間は 60 分、場所は検索の先頭の結果
 */
export function assume(
  draft: Draft,
  candidates: Map<string, Spot[]>,
  now: Date,
  home: LatLng,
): string[] {
  const warnings: string[] = [];
  const HALF_HOUR = 30 * MINUTE;
  // 今日の計画で、2時間後が翌日になるときは、対象日の 23:30 にする
  const later = toIso(new Date(Math.ceil((now.getTime() + 2 * 3600_000) / HALF_HOUR) * HALF_HOUR));
  const soon = later.startsWith(draft.date) ? later : atTime(draft.date, '23:30');
  for (const errand of selectedErrands(draft)) {
    const missing = missingOf(errand, now);
    if (missing.includes('place')) {
      const spot = candidates
        .get(errand.id)
        ?.find((s) => distanceMeters(home, s.location) <= ASSUME_WITHIN_METERS);
      if (!spot) {
        errand.selected = false;
        warnings.push(`「${errand.title}」は、場所が決まらなかったため、計画から外しました`);
        continue;
      }
      setSpot(errand, spot, home);
      draft.assumptions.push(`「${errand.title}」の場所を「${spot.name}」と仮定しました`);
    }
    if (missing.includes('start')) {
      errand.start = jstDate(now) === draft.date ? soon : atTime(draft.date, '10:00');
      delete errand.end;
      draft.assumptions.push(`「${errand.title}」の開始を ${hhmm(errand.start)} と仮定しました`);
    }
    if (errand.start && !errand.end) {
      const minutes = DURATION[errand.kind] ?? 60;
      errand.end = plus(errand.start, minutes);
      draft.assumptions.push(`「${errand.title}」の所要時間を ${minutes} 分と仮定しました`);
    }
    errand.assumed.push(...missing);
  }
  return warnings;
}

/**
 * 下書きの予定を、現在の設定で見直す：カレンダーの同意が OFF ならカレンダー由来の用事を落とし、
 * 無くなった・スキップしたルーティンを落とす。入力の用事にまとめていた場合は、入力の値に戻す。
 * 確認の対象の用事が落ちたときは、確認を「回答すれば続きから作る」だけのものに替える
 */
export function reconcile(draft: Draft, ctx: Pick<PlanContext, 'user' | 'events'>): void {
  const routines = new Set(ctx.events.filter((e) => e.date === draft.date).map((e) => e.ref));
  const usable = (ref: string) =>
    ref.startsWith('c') ? ctx.user.calendarUsageConsent : routines.has(ref);
  draft.errands = draft.errands.filter((e) => e.source === 'input' || !e.ref || usable(e.ref));
  for (const errand of draft.errands) {
    if (errand.source !== 'input' || !errand.ref || usable(errand.ref)) continue;
    if (errand.original?.place !== errand.place) delete errand.spot;
    Object.assign(errand, { place: undefined, start: undefined, end: undefined }, errand.original);
    delete errand.ref;
    delete errand.original;
  }
  const exists = (id?: string) => draft.errands.some((e) => e.id === id);
  draft.homeBetween = draft.homeBetween.filter(exists);
  if (draft.pending?.errandId && !exists(draft.pending.errandId)) {
    draft.pending = {
      kind: 'question',
      question: '予定の設定が変わりました。回答すると、続きから計画を作ります',
    };
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  supermarket: 'スーパー',
  drugstore: 'ドラッグストア',
  convenience: 'コンビニ',
  home_center: 'ホームセンター',
  bakery: 'パン屋',
  restaurant: '食事',
  other: '買い物',
};
/** 立寄りの呼び名（品目名は使わない） */
export const stopLabel = (stop: Pick<DraftStop, 'category' | 'chain'>) =>
  stop.chain ?? CATEGORY_LABEL[stop.category] ?? '買い物';

/** API 仕様（openapi.yaml）の Clarification にする。count は、これまでの質問の回数 */
export function toClarification(draft: Draft, count: number) {
  const { pending } = draft;
  if (!pending) return null;
  const selection = pending.kind === 'selection';
  const options = selection
    ? [
        ...[...draft.errands].sort(byStart).map((e) => ({
          id: e.id,
          group: 'errand' as const,
          label: e.title,
          detail: e.place,
          source: e.source,
          startTime: e.start,
          endTime: endOf(e),
          selected: e.selected,
          needsPlace: e.needsPlace,
        })),
        ...draft.stops.map((s) => ({
          id: s.id,
          group: 'stop' as const,
          label: stopLabel(s),
          selected: s.selected,
        })),
      ]
    : (pending.options ?? []).map((o) => ({
        id: o.id,
        group: 'place' as const,
        label: o.name,
        detail: o.address,
      }));
  return {
    kind: pending.kind,
    token: draft.rev,
    question: pending.question,
    count,
    maxCount: MAX_QUESTIONS,
    options,
    ...(selection && {
      limits: {
        maxErrands: MAX_ERRANDS,
        maxStops: MAX_STOPS,
        minTotal: 1,
        gapMinutes: GAP_MINUTES,
      },
    }),
    allowFreeText: !selection,
  };
}
