/**
 * 計画生成の流れ。入口（新規・確認への回答）ごとに始める位置が違うだけで、
 * 場所の確定から先（advance）と保存（savePlan）は共通。
 *
 *   新規：読み取り（AI①）→ 下書き → 予定の一覧（必要なときだけ）→ advance
 *   回答：回答の反映（自由入力は AI①の差分）→ advance
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
import { plan as planTable } from '../db/schema.js';
import { AppError, validationError } from '../errors.js';
import { RateLimitedError } from '../rate-limit.js';
import type { Ai } from './ai.js';
import { composePlan, type Composed, type ComposeErrand, type Travel } from './compose.js';
import type { PlanContext } from './context.js';
import {
  applyPatch,
  applyPlaceChoice,
  applySelection,
  assume,
  createDraft,
  jstDate,
  MAX_QUESTIONS,
  needsSelection,
  nextPending,
  reconcile,
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

const calendarWarning = (draft: Draft) =>
  draft.calendarFailed
    ? ['カレンダーの予定を取得できなかったため、予定なしで計画を作りました']
    : [];

/** 場所の確定から、組み立てまで */
async function advance(
  deps: PlannerDeps,
  ctx: PlanContext,
  draft: Draft,
  asked: number,
  inputText: string,
  sessions: Session[],
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
  if (pending && asked < MAX_QUESTIONS) {
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
  const found = await findStores(deps.maps, stops, anchors, {
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
  const decisions = await decide().catch((error: unknown) => {
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
  // 立寄りが1件も残らなかったときの、立寄りのスロットの判断文は、定型文にする
  const unknown = (text: string) => hasUnknownStation(text, composed.stations, sources);
  const noStops = stops.length > 0 && stops.every((s) => !s.options);
  draft.slots = decisions.slots.map(({ slot, decision }) => ({
    slot,
    decision:
      noStops && (slot === 'outbound_stops' || slot === 'return_stops')
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
    const used = await (completed
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
