/**
 * 計画生成の流れ。入口（新規・確認への回答・修正・項目の削除）ごとに始める位置が違うだけで、
 * 場所の確定から先（advance）と保存（savePlan）は共通。
 *
 *   新規：読み取り（AI①）→ 下書き → 予定の一覧（必要なときだけ）→ advance
 *   回答：回答の反映（自由入力は AI①の差分）→ advance
 *   修正：修正指示の読み取り（AI①）→ 下書きに反映 → advance（確認はせず、仮定で埋める）
 *   削除：下書きから外す → advance（立寄りの削除なら、店と判断文はそのまま使い、AI を呼ばない）
 *   advance：場所の確定 → 確認（場所の候補・質問。2回まで）→ 店の候補 → 判断（AI②）
 *            → 選択の検証 → 経路の取得と組み立て → 名称の検証
 *
 * 外部 API を呼ぶ部分（〜advance）と DB に書く部分（savePlan）を分けている。
 * 期限（13 秒）は、呼び出し側（routes/plans.ts）が前者にだけ掛ける。
 */
import { and, eq, sql } from 'drizzle-orm';
import type { GoogleMapsClient } from '../adapters/google-maps.js';
import { ExternalApiError } from '../adapters/http.js';
import type { Db } from '../db/client.js';
import { repositories } from '../db/repositories/index.js';
import type { NewAgentSession } from '../db/repositories/agent-session-repository.js';
import type { Plan } from '../db/repositories/plan-repository.js';
import { plan as planTable, planItem, slotEvaluation } from '../db/schema.js';
import { AppError, validationError } from '../errors.js';
import { RateLimitedError } from '../rate-limit.js';
import type { Ai } from './ai.js';
import { composePlan, type Composed, type ComposeErrand, type Travel } from './compose.js';
import type { PlanContext } from './context.js';
import {
  applyPatch,
  applyPlaceChoice,
  applyRevision,
  applySelection,
  assume,
  createDraft,
  jstDate,
  MAX_QUESTIONS,
  needsSelection,
  nextPending,
  reconcile,
  removeFromDraft,
  selectedErrands,
  selectedStops,
  setSpot,
  stopLabel,
  hhmm,
  toIso,
  type Draft,
  type DraftErrand,
} from './draft.js';
import { findPlaces, findStores, type Spot, type StoreAnchor } from './lookup.js';
import { decideCall, interpretCall, patchCall } from './prompts.js';
import { SLOTS } from './slots.js';

export const DAILY_LIMIT = 20;

export interface PlannerDeps {
  ai: Ai;
  maps: GoogleMapsClient;
  /** 利用者の設定（歩く速さ・優先条件）に合わせた、移動の取得 */
  travel: (options: {
    walkingSpeed: 'slow' | 'normal' | 'fast';
    priority: 'on_time' | 'save_money' | 'points';
  }) => Travel;
  now: () => Date;
  /** 期限までの残り時間（ミリ秒）。やり直し・取り直しをするかの判断に使う */
  remainingMs: () => number;
}

type Session = Omit<NewAgentSession, 'planId'>;

export interface Outcome {
  status: 'clarifying' | 'completed' | 'error';
  draft: Draft;
  /** これまでに出した質問の回数（この結果の質問を含む。予定の一覧は数えない） */
  questions: number;
  composed?: Composed;
  assumptions: string[];
  warnings: string[];
  /** 立寄りごとの品目（AI①が読み取った応答のときだけ。保存しない） */
  purchaseItems?: { sourceId: string; items: string[] }[];
  sessions: Session[];
}

export interface ClarifyAnswer {
  answer?: string;
  selectedIds?: string[];
  places?: { id: string; at: 'home' | 'stay' | 'place'; text?: string }[];
  homeBetween?: string[];
}

/** 409 CONFLICT。理由（HOME_NOT_SET など）を details[].field に入れる */
export const conflict = (reason: string, message: string) =>
  new AppError(409, 'CONFLICT', '現在の状態では実行できません', [{ field: reason, message }]);

const timeOf = (iso?: string) => (iso ? hhmm(iso) : null);
const invalid = (field: string, message: string) => validationError([{ field, message }]);

const STATION = /([一-龠々ヶァ-ヶー]{1,12})駅/g;
/** 駅名ではない「◯◯駅」（最寄駅・乗換駅・各駅停車 など） */
const GENERIC = /^(最寄|乗換|各|到着|出発|下車|乗車|降車|途中|隣|同|当|次|始発|終着|目的)$/;

/**
 * 文の中の「◯◯駅」に、知っている名称（経路の駅名と、sources に書かれた駅名）に無いものがあるか。
 * AI が書いた文に、実在の確認が取れない駅名を残さないために使う。
 * 前に語が続く書き方（「13時東京駅」）を通すため、末尾の一致で比べる。そのため、
 * 「新宿」を知っているときの「西新宿駅」のように、前に字が付いただけの別の駅は見分けられない
 */
export function hasUnknownStation(text: string, stations: string[], sources: string): boolean {
  const known = [
    // 括弧書き（「大宮（埼玉県）」）を外し、「駅」の有無をそろえる
    ...stations.map((s) => s.replace(/[（(].*$/, '').replace(/駅$/, '')),
    ...[...sources.matchAll(STATION)].map((m) => m[1] ?? ''),
  ].filter((s) => s.length >= 2);
  return [...text.matchAll(STATION)].some(([, run = '']) => {
    if (GENERIC.test(run)) return false;
    return !known.some((s) => run.endsWith(s) || (run.length >= 2 && s.endsWith(run)));
  });
}

/** 新規：入力文を読み取り、下書きを作って進める */
export async function startPlan(
  deps: PlannerDeps,
  ctx: PlanContext,
  inputText: string,
): Promise<Outcome> {
  const now = deps.now();
  const today = jstDate(now);
  const intent = await deps.ai.callTool(
    interpretCall({
      now: toIso(now),
      text: inputText,
      ...(ctx.memos.length > 0 && { memos: ctx.memos }),
      events: ctx.events.map((e) => ({
        id: e.ref,
        date: e.date === today ? 'today' : 'tomorrow',
        title: e.title,
        place: e.place,
        start: e.start,
        end: e.end,
      })),
    }),
  );
  if (intent.rejected) throw invalid('inputText', '外出の用事や買い物を入力してください');
  if (intent.date === 'other') throw invalid('inputText', '今日か明日の計画だけ作れます');

  const draft = createDraft(intent, ctx.events, now);
  draft.calendarFailed = ctx.calendarFailed || undefined;
  // AI が書いた仮定に、入力にも予定にも無い駅名があれば、その文を捨てる
  const written = [inputText, ...ctx.events.flatMap((e) => [e.title, e.place ?? ''])].join('\n');
  draft.assumptions = draft.assumptions.filter((text) => !hasUnknownStation(text, [], written));
  if (draft.errands.length + draft.stops.length === 0) {
    throw invalid('inputText', '用事や買い物を読み取れませんでした。内容を確認してください');
  }
  const purchaseItems = draft.stops
    .map((stop, index) => ({ sourceId: stop.id, items: intent.stops[index]?.items ?? [] }))
    .filter((p) => p.items.length > 0);
  const sessions: Session[] = [
    {
      sessionType: 'intent',
      inputSummary: `入力 ${[...inputText].length}文字／メモ ${ctx.memos.length}件／予定 ${ctx.events.length}件`,
      outputSummary: `用事 ${intent.errands.length}件、立寄り ${intent.stops.length}件`,
      judgmentResult: `対象日 ${intent.date === 'today' ? '今日' : '明日'}／移動 ${draft.mode}`,
    },
  ];

  if (needsSelection(draft)) {
    draft.pending = { kind: 'selection', question: '計画に入れる予定を選んでください' };
    return {
      status: 'clarifying',
      draft,
      questions: 0,
      assumptions: draft.assumptions,
      warnings: calendarWarning(draft),
      purchaseItems,
      sessions,
    };
  }
  draft.selectionDone = true;
  return { ...(await advance(deps, ctx, draft, 0, inputText, sessions)), purchaseItems };
}

/** 確認への回答：回答を下書きに反映して進める */
export async function answerPlan(
  deps: PlannerDeps,
  ctx: PlanContext,
  plan: Pick<Plan, 'draft' | 'clarificationCount' | 'inputText'>,
  request: ClarifyAnswer,
): Promise<Outcome> {
  const draft = structuredClone(plan.draft) as Draft;
  const pending = draft.pending;
  if (!pending) throw conflict('STATE_MISMATCH', '確認中の計画ではありません');
  // 設定が変わっていれば、使えなくなった予定を落とす（確認の対象が落ちたら、回答は反映せずに進む）
  reconcile(draft, ctx);

  const errand = draft.errands.find((e) => e.id === pending.errandId);
  let summary: string;
  if (pending.kind === 'selection') {
    if (!request.selectedIds) throw invalid('selectedIds', '必須の項目です');
    applySelection(draft, { ...request, selectedIds: request.selectedIds });
    summary = `予定の一覧：用事 ${selectedErrands(draft).length}件、立寄り ${selectedStops(draft).length}件`;
  } else if (pending.kind === 'place' && request.selectedIds?.length === 1 && !request.answer) {
    if (errand && ctx.home) applyPlaceChoice(draft, request.selectedIds[0] ?? '', ctx.home);
    summary = '場所の候補から選択';
  } else if (request.answer) {
    if (errand) {
      const patch = await deps.ai.callTool(
        patchCall({
          now: toIso(deps.now()),
          errand: {
            title: errand.title,
            place: errand.place ?? null,
            startTime: timeOf(errand.start),
            endTime: timeOf(errand.end),
          },
          question: pending.question,
          answer: request.answer,
        }),
      );
      applyPatch(draft, errand.id, patch);
    }
    summary = `自由入力 ${[...request.answer].length}文字`;
  } else {
    throw invalid('answer', '必須の項目です');
  }
  delete draft.pending;
  const sessions: Session[] = [
    { sessionType: 'clarify', inputSummary: summary, outputSummary: `確認：${pending.kind}` },
  ];
  return advance(deps, ctx, draft, plan.clarificationCount, plan.inputText, sessions);
}

export interface Revision {
  instruction: string;
  /** 画面が保持している品目（立寄りの ID ごと）。AI①に渡すだけで、保存しない */
  purchaseItems?: { sourceId: string; items: string[] }[];
}
type Completed = Pick<Plan, 'draft' | 'clarificationCount' | 'inputText'>;

/** 修正：修正指示を読み取り（AI①）、下書きに反映して作り直す。計画が完成しなければ、何も変えない */
export async function revisePlan(
  deps: PlannerDeps,
  ctx: PlanContext,
  plan: Completed,
  request: Revision,
): Promise<Outcome> {
  const now = deps.now();
  const draft = structuredClone(plan.draft) as Draft;
  reconcile(draft, ctx);
  const date = draft.date === jstDate(now) ? 'today' : 'tomorrow';
  const stops = selectedStops(draft);
  const started = startedErrands(draft, now);
  const kept = (request.purchaseItems ?? []).filter((p) => stops.some((s) => s.id === p.sourceId));
  // 予定（カレンダー・ルーティン）は読み直さない
  const intent = await deps.ai.callTool(
    interpretCall({
      now: toIso(now),
      text: request.instruction,
      events: [],
      current: {
        date,
        mode: draft.mode,
        errands: selectedErrands(draft).map((e) => ({
          id: e.id,
          title: e.title,
          kind: e.kind,
          place: e.place ?? null,
          placeIsSpecific: e.specific,
          startTime: timeOf(e.start),
          endTime: timeOf(e.end),
        })),
        stops: stops.map(({ id, category, chain, perishable }) => ({
          id,
          category,
          chain: chain ?? null,
          perishable,
        })),
        purchaseItems: Object.fromEntries(kept.map((p) => [p.sourceId, p.items])),
      },
    }),
  );
  if (intent.rejected) throw invalid('instruction', '計画の修正の内容を入力してください');
  const revised = applyRevision(draft, intent);
  refuseStarted(draft, started);
  if (intent.date !== date) {
    revised.warnings.push('対象日は変更できません。日付はそのままで作り直しました');
  }
  if (selectedErrands(draft).length + selectedStops(draft).length === 0) {
    throw invalid('instruction', '用事か立寄りを1件以上残してください');
  }
  const sessions: Session[] = [
    {
      sessionType: 'intent',
      inputSummary: `修正 ${[...request.instruction].length}文字`,
      outputSummary: `用事 ${intent.errands.length}件、立寄り ${intent.stops.length}件、取りやめ ${intent.removedIds.length}件`,
    },
  ];
  const text = `${plan.inputText}\n${request.instruction}`;
  const outcome = await advance(
    deps,
    ctx,
    draft,
    plan.clarificationCount,
    text,
    sessions,
    'assume',
  );
  if (outcome.status !== 'completed') {
    throw invalid('instruction', outcome.warnings.at(-1) ?? '計画を作れませんでした');
  }
  // 品目：AI が返した立寄りはその品目、返さなかった立寄りは画面が持っていた品目
  const items = new Map([
    ...kept.map((p) => [p.sourceId, p.items] as const),
    ...intent.stops.map((stop, index) => [revised.stopIds[index] ?? '', stop.items] as const),
  ]);
  return {
    ...outcome,
    warnings: [...revised.warnings, ...outcome.warnings],
    purchaseItems: selectedStops(draft)
      .map((s) => ({ sourceId: s.id, items: items.get(s.id) ?? [] }))
      .filter((p) => p.items.length > 0),
  };
}

/**
 * 項目の削除：元の用事・立寄り（sourceId）を下書きから外して作り直す。
 * 立寄りの削除なら、残りの店と判断文をそのまま使う。用事の削除なら、店の候補から取り直す
 */
export async function removeItem(
  deps: PlannerDeps,
  ctx: PlanContext,
  plan: Completed,
  sourceId: string | null,
): Promise<Outcome> {
  const refuse = (message: string) => conflict('NOT_DELETABLE', message);
  if (!sourceId) throw refuse('出発・移動・帰宅の項目は削除できません');
  const draft = structuredClone(plan.draft) as Draft;
  const before = JSON.stringify(draft.errands);
  const started = startedErrands(draft, deps.now());
  reconcile(draft, ctx);
  removeFromDraft(draft, new Set([sourceId]));
  refuseStarted(draft, started);
  if (selectedErrands(draft).length + selectedStops(draft).length === 0) {
    throw refuse('用事も立寄りも残らなくなる項目は削除できません');
  }
  // 用事が変わらなければ（立寄りの削除で、設定の変更で落ちた予定も無い）、店を選び直さない
  const mode = JSON.stringify(draft.errands) === before ? 'reuse' : 'assume';
  const outcome = await advance(
    deps,
    ctx,
    draft,
    plan.clarificationCount,
    plan.inputText,
    [],
    mode,
  );
  if (outcome.status !== 'completed') throw refuse('この項目を削除すると、計画を作れません');
  return outcome;
}

/** すでに始まっている用事（ID と開始）。作り直すと、いまから向かう計画になってしまう */
const startedErrands = (draft: Draft, now: Date) =>
  selectedErrands(draft)
    .filter((e) => e.start && Date.parse(e.start) <= now.getTime())
    .map((e) => `${e.id}@${e.start}`);
/** 始まっている用事が、変えずに残っていたら 409 */
function refuseStarted(draft: Draft, started: string[]): void {
  if (selectedErrands(draft).some((e) => started.includes(`${e.id}@${e.start}`))) {
    throw conflict(
      'PLAN_EXPIRED',
      'すでに始まっている用事があるため、作り直せません。新しく計画を作ってください',
    );
  }
}

const calendarWarning = (draft: Draft) =>
  draft.calendarFailed
    ? ['カレンダーの予定を取得できなかったため、予定なしで計画を作りました']
    : [];

/**
 * 場所の確定から、組み立てまで。
 * mode：ask＝足りない項目を質問する／assume＝質問せず仮定で埋める（修正・削除）／
 * reuse＝assume に加えて、下書きの店と判断文をそのまま使う（立寄りの削除。AI を呼ばない）
 */
async function advance(
  deps: PlannerDeps,
  ctx: PlanContext,
  draft: Draft,
  asked: number,
  inputText: string,
  sessions: Session[],
  mode: 'ask' | 'assume' | 'reuse' = 'ask',
): Promise<Outcome> {
  const now = deps.now();
  const home = ctx.home;
  if (!home) throw conflict('HOME_NOT_SET', '自宅の住所を設定してください');
  const warnings = calendarWarning(draft);
  const outcome = (status: Outcome['status'], questions = asked): Outcome => ({
    status,
    draft,
    questions,
    assumptions: draft.assumptions,
    warnings,
    sessions,
  });

  // 場所の確定：固有の名称で、検索で見つかれば、その先頭を使う。それ以外は候補として残す
  const candidates = new Map<string, Spot[]>();
  await Promise.all(
    selectedErrands(draft)
      .filter((e) => e.at === 'place' && !e.spot && e.place)
      .map(async (errand) => {
        const found = await findPlaces(deps.maps, errand.place ?? '', home);
        if (errand.specific && found[0]) setSpot(errand, found[0], home);
        else candidates.set(errand.id, found);
      }),
  );

  // 確認（2回まで）。上限に達したら、残りは仮定で埋める
  const pending = nextPending(draft, candidates, now);
  if (pending && mode === 'ask' && asked < MAX_QUESTIONS) {
    draft.pending = pending;
    sessions.push({
      sessionType: 'clarify',
      inputSummary: `質問 ${asked + 1}回目`,
      outputSummary: `確認：${pending.kind}`,
      judgmentResult: `不足 ${(pending.missing ?? ['place']).join('・')}`,
    });
    return outcome('clarifying', asked + 1);
  }
  if (pending) warnings.push(...assume(draft, candidates, now, home));

  const errands = selectedErrands(draft);
  const stops = selectedStops(draft);
  if (errands.length + stops.length === 0) {
    warnings.push('計画に入れられる用事・立寄りがありません');
    return outcome('error');
  }

  // 店の候補：自宅・最初の用事・最後の用事の周辺
  const visits = errands.filter((e) => e.at === 'place' && e.spot);
  const first = visits[0];
  const last = visits.at(-1);
  const time = (iso: string | undefined, minutes = 0) =>
    new Date(Date.parse(iso ?? '') + minutes * 60_000);
  const shopping =
    draft.shoppingTime !== undefined
      ? new Date(`${draft.date}T${draft.shoppingTime}:00+09:00`)
      : jstDate(now) === draft.date
        ? new Date(now.getTime() + ctx.user.preparationTimeMinutes * 60_000)
        : new Date(`${draft.date}T10:00:00+09:00`);
  const anchorOf = (e: DraftErrand): StoreAnchor[] =>
    e.spot
      ? [{ id: e.id, location: e.spot.location, before: time(e.start), after: time(e.end) }]
      : [];
  const anchors: StoreAnchor[] = [
    {
      id: 'home',
      location: home,
      // 自宅の近くに寄る時刻の目安：最初の用事の1時間前と、最後の用事の30分後
      before: first ? time(first.start, -60) : shopping,
      after: last ? time(last.end, 30) : shopping,
    },
    ...(first ? anchorOf(first) : []),
    ...(last && last !== first ? anchorOf(last) : []),
  ];
  const priority = ctx.user.priorityCondition as 'on_time' | 'save_money' | 'points';
  // 下書きの店を使うとき：選んであった店を先頭の候補（c0）にして、そのまま選ばせる
  const kept = mode === 'reuse' ? stops.filter((s) => s.options && s.anchor && s.when) : [];
  const found =
    mode === 'reuse'
      ? {
          candidates: kept.flatMap((s) =>
            (s.options ?? []).map((store, index) => ({
              stopId: s.id,
              candidate: `c${index}`,
              anchor: s.anchor ?? 'home',
              when: [s.when ?? 'after'],
              distanceMeters: 0,
              store,
            })),
          ),
          failedStopIds: [],
        }
      : await findStores(deps.maps, stops, anchors, {
          programs: ctx.programs,
          pointsFirst: priority === 'points',
        });

  // 判断（AI②）。形が合わない出力は、時間が残っていれば1回だけやり直す
  const decide = () =>
    deps.ai.callTool(
      decideCall({
        now: toIso(now),
        mode: draft.mode,
        priority,
        errands: errands.map((e) => ({
          id: e.id,
          title: e.title,
          kind: e.kind,
          at: e.at,
          place: e.spot?.name ?? null,
          start: timeOf(e.start),
          end: timeOf(e.end),
        })),
        stops: stops.map(({ id, category, chain, perishable }) => ({
          id,
          category,
          chain: chain ?? null,
          perishable,
        })),
        candidates: found.candidates.map((c) => ({
          stopId: c.stopId,
          candidate: c.candidate,
          anchor: c.anchor,
          when: c.when,
          name: c.store.name,
          distanceMeters: c.distanceMeters,
          point: c.store.pointProgramCode ?? null,
        })),
      }),
    );
  const decisions =
    mode === 'reuse'
      ? {
          slots: draft.slots ?? [],
          stopovers: kept.map((s) => ({ stopId: s.id, candidate: 'c0', when: s.when ?? 'after' })),
        }
      : await decide().catch((error: unknown) => {
          const retry =
            error instanceof ExternalApiError &&
            error.kind === 'invalid_response' &&
            deps.remainingMs() > 6000;
          if (retry) return decide();
          throw error;
        });

  // 選択の検証：候補に無い番号は使わない。選ばれなかった立寄りは外す
  for (const stop of stops) {
    const choice = decisions.stopovers.find((s) => s.stopId === stop.id);
    const picked = found.candidates.find(
      (c) => c.stopId === stop.id && c.candidate === choice?.candidate,
    );
    delete stop.options;
    if (!picked || !choice) {
      warnings.push(
        found.failedStopIds.includes(stop.id)
          ? `店を検索できなかったため、「${stopLabel(stop)}」への立寄りを外しました`
          : `寄れる店が見つからなかったため、「${stopLabel(stop)}」への立寄りを外しました`,
      );
      continue;
    }
    const when = picked.when.includes(choice.when) ? choice.when : (picked.when[0] ?? 'after');
    const alternatives = found.candidates.filter(
      (c) =>
        c !== picked && c.stopId === stop.id && c.anchor === picked.anchor && c.when.includes(when),
    );
    Object.assign(stop, {
      anchor: picked.anchor,
      when,
      options: [picked, ...alternatives].map((c) => c.store),
    });
  }

  // 経路の取得と組み立て。件名の「◯◯駅」が入力文にも確定した場所名にも無ければ、場所名に置き換える
  // （予定の件名・場所は利用者が登録したものなので、そのまま使い、知っている名称にも入れる）
  const sources = [
    inputText,
    ...errands.flatMap((e) => [e.spot?.name, e.place, e.source !== 'input' && e.title]),
  ].join('\n');
  const composed = await composePlan(
    {
      now,
      date: draft.date,
      home,
      mode: draft.mode,
      errands: errands.flatMap((e): ComposeErrand[] =>
        e.start && e.end
          ? [
              {
                id: e.id,
                title:
                  e.source === 'input' && e.spot && hasUnknownStation(e.title, [], sources)
                    ? `${e.spot.name}での用事`
                    : e.title,
                kind: e.kind,
                at: e.at,
                name: e.spot?.name,
                location: e.spot?.location,
                start: new Date(e.start),
                end: new Date(e.end),
              },
            ]
          : [],
      ),
      stops: stops.flatMap((s) =>
        s.options && s.anchor && s.when
          ? [{ id: s.id, category: s.category, anchor: s.anchor, when: s.when, options: s.options }]
          : [],
      ),
      homeBetween: draft.homeBetween,
      shoppingTime: draft.shoppingTime,
      preparationMinutes: ctx.user.preparationTimeMinutes,
      priority,
      canRetry: () => deps.remainingMs() >= 3000,
    },
    deps.travel({
      walkingSpeed: ctx.user.walkingSpeed as 'slow' | 'normal' | 'fast',
      priority,
    }),
  );
  for (const stop of stops) {
    if (composed.droppedStopIds.includes(stop.id)) delete stop.options;
  }
  // 立寄りがすべて外れて、何も残らなかったとき（生成回数は数えない）
  if (composed.items.length === 0) {
    warnings.push(...composed.warnings, '計画に入れられる用事・立寄りがありません');
    return outcome('error');
  }

  // 名称の検証：AI の文（判断文・仮定）に、確認の取れない駅名があれば捨てる。
  // 往路・復路に立寄りが入らなかったときの、立寄りのスロットの判断文は、定型文にする
  const unknown = (text: string) => hasUnknownStation(text, composed.stations, sources);
  const hasStop = (type: 'OUTBOUND' | 'RETURN') =>
    composed.items.some((i) => i.slotType === type && stops.some((s) => s.id === i.sourceId));
  draft.slots = decisions.slots.map(({ slot, decision }) => ({
    slot,
    decision:
      (slot === 'outbound_stops' && !hasStop('OUTBOUND')) ||
      (slot === 'return_stops' && !hasStop('RETURN'))
        ? '立寄りはありません'
        : unknown(decision) || decision === ''
          ? '問題はありません'
          : decision,
  }));
  draft.assumptions = draft.assumptions.filter((text) => !unknown(text));

  sessions.push({
    sessionType: 'compose',
    inputSummary: `用事 ${errands.length}件、立寄り ${stops.length}件、店の候補 ${found.candidates.length}件`,
    outputSummary: `完成：行動項目 ${composed.items.length}件、立寄り ${stops.filter((s) => s.options).length}件`,
    judgmentResult: `注意 ${warnings.length + composed.warnings.length}件／仮定 ${draft.assumptions.length + composed.assumptions.length}件`,
  });
  return {
    ...outcome('completed'),
    composed,
    assumptions: [...draft.assumptions, ...composed.assumptions],
    warnings: [...warnings, ...composed.warnings],
  };
}

export interface SaveArgs {
  userId: string;
  inputText: string;
  /** 回答で更新する計画（新規なら undefined） */
  existing?: Plan;
  outcome: Outcome;
  /** 生成回数を数える日（日本時間の YYYY-MM-DD） */
  quotaDate: string;
  /** 1日の上限に達したときの、Retry-After の秒数 */
  retryAfterSeconds: number;
  /** 保存を終える期限（エポックミリ秒）。過ぎたら、すべて取り消す */
  saveBy: number;
  /** 生成回数に数えない（項目の削除） */
  free?: boolean;
}

/**
 * 結果を保存する（1トランザクション）。計画が完成したときは、生成回数を数える。
 * - 回答の保存は、「読んだときと同じ状態・版数」を条件にする。変わっていたら 409
 * - 生成回数が上限を超えたら、すべて取り消して 429
 * - 期限（saveBy）を過ぎたら、すべて取り消して時間切れにする（接続・ロックの待ちで、画面が諦めたあとに保存しない）
 */
export async function savePlan(db: Db, args: SaveArgs) {
  const { userId, existing, outcome } = args;
  const previousRev = (existing?.draft as Draft | null)?.rev ?? 0;
  const draft: Draft = { ...outcome.draft, rev: previousRev + 1 };
  const completed = outcome.status === 'completed';
  const values = {
    status: outcome.status,
    targetDate: draft.date,
    departureTime: outcome.composed?.departure ?? null,
    returnTime: outcome.composed?.return ?? null,
    clarificationCount: outcome.questions,
    clarificationQuestion: draft.pending?.question.slice(0, 255) ?? null,
    assumptions: outcome.assumptions,
    warnings: outcome.warnings,
    draft,
  };
  const timeout = () => new ExternalApiError('agent', 'save', 'timeout');
  const run = db.transaction(async (tx) => {
    const left = Math.ceil(args.saveBy - Date.now());
    if (left <= 0) throw timeout();
    // 1文ごとの待ちの上限（この取引の中だけ）
    await tx.execute(sql`select set_config('statement_timeout', ${String(left)}, true)`);
    const repos = repositories(tx);
    let plan: Plan | undefined;
    if (existing) {
      [plan] = await tx
        .update(planTable)
        .set(values)
        .where(
          and(
            eq(planTable.id, existing.id),
            eq(planTable.userId, userId),
            eq(planTable.status, existing.status),
            sql`(${planTable.draft}->>'rev')::int = ${previousRev}`,
          ),
        )
        .returning();
      if (!plan) throw conflict('CONCURRENT_UPDATE', '計画が同時に更新されました');
      // 修正・削除では、前の項目とスロット評価を入れ替える
      await tx.delete(planItem).where(eq(planItem.planId, plan.id));
      await tx.delete(slotEvaluation).where(eq(slotEvaluation.planId, plan.id));
    } else {
      plan = await repos.plans.create({ userId, inputText: args.inputText, ...values });
    }
    const planId = plan.id;
    const items = await repos.planItems.insertMany(
      (outcome.composed?.items ?? []).map((item, index) => ({
        planId,
        sequence: index + 1,
        slotType: item.slotType,
        itemType: item.itemType,
        title: item.title,
        startTime: item.start,
        endTime: item.end,
        locationName: item.locationName?.slice(0, 255),
        locationLatitude: item.location?.lat,
        locationLongitude: item.location?.lng,
        transportMode: item.transportMode,
        routeDetail: item.route,
        store: item.store,
        stationExit: item.stationExit?.slice(0, 255),
        boardingPosition: item.boardingPosition?.slice(0, 255),
        description: item.description,
        sourceId: item.sourceId,
      })),
    );
    if (completed) {
      await repos.slotEvaluations.insertMany(
        SLOTS.map((slot, index) => ({
          planId,
          slotType: slot.type,
          slotName: slot.name,
          evaluationOrder: index + 1,
          isEvaluated: true,
          evaluationResult: draft.slots?.find((s) => s.slot === slot.id)?.decision,
        })),
      );
    }
    for (const session of outcome.sessions)
      await repos.agentSessions.insert({ planId, ...session });
    const quota = repos.generationQuotas;
    const used = await (completed && !args.free
      ? quota.increment(userId, args.quotaDate)
      : quota.getUsedCount(userId, args.quotaDate));
    if (used > DAILY_LIMIT) throw new RateLimitedError(args.retryAfterSeconds);
    if (Date.now() >= args.saveBy) throw timeout();
    return { plan, items, used };
  });
  // DB が文を打ち切ったときも、時間切れとして返す
  return run.catch((error: unknown) => {
    throw error instanceof AppError || Date.now() < args.saveBy ? error : timeout();
  });
}
