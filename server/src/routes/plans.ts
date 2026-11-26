/**
 * 行動計画の API（/agent/plans）：生成・取得・確認への回答・修正・項目の削除と、準備のみの2本。
 * ここでは、入力の検証・回数の制限・期限・応答の形を扱う。生成の中身は agent/planner.ts。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GoogleMapsClient } from '../adapters/google-maps.js';
import { ExternalApiError } from '../adapters/http.js';
import type { NavitimeClient } from '../adapters/navitime.js';
import type { Ai } from '../agent/ai.js';
import { loadContext, storedCalendar, type CalendarSource } from '../agent/context.js';
import { jstDate, reconcile, toClarification, toIso, type Draft } from '../agent/draft.js';
import { createTravel } from '../agent/lookup.js';
import {
  answerPlan,
  conflict,
  DAILY_LIMIT,
  removeItem,
  revisePlan,
  savePlan,
  startPlan,
  type Outcome,
  type PlannerDeps,
} from '../agent/planner.js';
import type { Db } from '../db/client.js';
import { repositories } from '../db/repositories/index.js';
import type { PlanItem } from '../db/repositories/plan-item-repository.js';
import type { Plan } from '../db/repositories/plan-repository.js';
import { AppError, featureDisabled, unauthorized } from '../errors.js';
import { toLoggableError } from '../logging.js';
import { createRateLimiter, RateLimitedError } from '../rate-limit.js';
import { parseInput } from '../validation.js';

export interface PlanRouteOptions {
  /** DB・AI・Google Maps のどれかが未設定の環境では、計画の API は 500 を返す */
  db?: Db;
  ai?: Ai;
  /** 計画生成用の外部 API クライアント（タイムアウト 2.5 秒・リトライなし） */
  googleMaps?: GoogleMapsClient;
  navitime?: NavitimeClient;
  /** カレンダーの予定の取得元。指定しなければ、同期済みの予定（calendar_event）を読む */
  calendar?: CalendarSource;
  /** テスト用 */
  now?: () => Date;
  deadlineMs?: number;
}

/**
 * サーバ処理を打ち切るまでの時間（要求を受けた時点から数える）。
 * この 0.5 秒前までに外部 API の処理が終わっていれば、保存して成功にする。
 * 保存は期限の 1 秒後までに終える（画面は 15 秒で諦める）。過ぎたら取り消す
 */
const DEADLINE_MS = 13_000;
const CHECKPOINT_MARGIN_MS = 500;
const SAVE_MARGIN_MS = 1000;

const id = z.string().min(1).max(32);
const CreatePlanRequest = z.strictObject({ inputText: z.string().trim().min(1).max(500) });
const ClarifyRequest = z.strictObject({
  token: z.number().int(),
  answer: z.string().trim().min(1).max(500).optional(),
  selectedIds: z.array(id).max(20).optional(),
  places: z
    .array(
      z.strictObject({
        id,
        at: z.enum(['home', 'stay', 'place']),
        text: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .max(20)
    .optional(),
  homeBetween: z.array(id).max(5).optional(),
});
const ReviseRequest = z.strictObject({
  instruction: z.string().trim().min(1).max(500),
  purchaseItems: z
    .array(
      z.strictObject({ sourceId: id, items: z.array(z.string().trim().min(1).max(40)).max(20) }),
    )
    .max(10)
    .optional(),
});
const ReplanRequest = z.strictObject({ delayMinutes: z.number().int().min(1).max(240) });
const DepartureDetectedRequest = z.strictObject({
  actualDepartureTime: z.iso.datetime({ offset: true }),
});
const positive = z.coerce.number().int().positive();
const PlanId = z.object({ planId: positive });
const ItemId = z.object({ planId: positive, itemId: positive });

/** カレンダーを取得しない（同意とルーティンだけを見直すとき） */
const NO_CALENDAR: CalendarSource = { list: async () => [] };
const iso = (date: Date | null) => (date ? toIso(date) : null);
/** 次の日本時間 0 時 */
const nextReset = (now: Date) => new Date(`${jstDate(now)}T00:00:00+09:00`).getTime() + 86_400_000;

/** DB の行を、API 仕様（openapi.yaml）の Plan にする */
function toPlan(
  plan: Plan,
  items: PlanItem[],
  used: number,
  now: Date,
  purchaseItems?: Outcome['purchaseItems'],
) {
  const draft = plan.draft as Draft | null;
  return {
    id: plan.id,
    status: plan.status,
    inputText: plan.inputText,
    targetDate: plan.targetDate,
    departureTime: iso(plan.departureTime),
    returnTime: iso(plan.returnTime),
    ...(purchaseItems && { purchaseItems }),
    clarification:
      plan.status === 'clarifying' && draft
        ? toClarification(draft, plan.clarificationCount)
        : null,
    assumptions: plan.assumptions,
    warnings: plan.warnings,
    items: items.map((item) => ({
      id: item.id,
      sequence: item.sequence,
      itemType: item.itemType,
      slotType: item.slotType,
      startTime: toIso(item.startTime),
      endTime: toIso(item.endTime),
      title: item.title,
      description: item.description ?? undefined,
      locationName: item.locationName ?? undefined,
      location:
        item.locationLatitude !== null && item.locationLongitude !== null
          ? { lat: item.locationLatitude, lng: item.locationLongitude }
          : undefined,
      transportMode: item.transportMode ?? undefined,
      route: item.routeDetail ?? undefined,
      stationExit: item.stationExit ?? undefined,
      boardingPosition: item.boardingPosition ?? undefined,
      store: item.store ?? undefined,
      sourceId: item.sourceId ?? undefined,
    })),
    quota: { used, limit: DAILY_LIMIT, resetAt: toIso(new Date(nextReset(now))) },
    createdAt: toIso(plan.createdAt),
    updatedAt: toIso(plan.updatedAt),
  };
}

export async function planRoutes(app: FastifyInstance, opts: PlanRouteOptions): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
  // 1分に10回まで（生成・回答・修正・削除の合算）。連打による外部 API の課金を抑える
  const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

  const dependencies = () => {
    if (!opts.db || !opts.ai || !opts.googleMaps) {
      throw new Error(
        '計画の API に必要な設定（DATABASE_URL・BEDROCK_MODEL_ID・GOOGLE_MAPS_SERVER_KEY）がありません',
      );
    }
    return { db: opts.db, ai: opts.ai, maps: opts.googleMaps, repos: repositories(opts.db) };
  };

  /**
   * 生成・回答の共通部分。外部 API を呼ぶ処理（work）に期限を掛け、間に合えば保存して返す。
   * 入口で1日の上限を確かめ、達していれば外部 API を呼ばずに 429 にする
   */
  async function generate(
    userId: string,
    inputText: string,
    existing: Plan | undefined,
    work: (planner: PlannerDeps, ctx: Awaited<ReturnType<typeof loadContext>>) => Promise<Outcome>,
    startedAt = Date.now(),
    /** 生成回数に数えない（項目の削除） */
    free = false,
  ) {
    const { db, ai, maps, repos } = dependencies();
    const time = now();
    const retryAfterSeconds = Math.ceil((nextReset(time) - time.getTime()) / 1000);
    const timeout = () => new ExternalApiError('agent', 'deadline', 'timeout');
    let timer: NodeJS.Timeout | undefined;
    const run = (async () => {
      const used = free ? 0 : await repos.generationQuotas.getUsedCount(userId, jstDate(time));
      if (used >= DAILY_LIMIT) {
        throw new RateLimitedError(retryAfterSeconds);
      }
      // 回答のときは、カレンダーを取り直さない（予定は下書きにある。同意とルーティンだけを見直す）
      const calendar = existing ? NO_CALENDAR : (opts.calendar ?? storedCalendar(repos));
      const ctx = await loadContext(repos, calendar, userId, time);
      if (!ctx.home) throw conflict('HOME_NOT_SET', '自宅の住所を設定してください');
      return work(
        {
          ai,
          maps,
          travel: (options) => createTravel({ googleMaps: maps, navitime: opts.navitime }, options),
          now,
          remainingMs: () => startedAt + deadlineMs - Date.now(),
        },
        ctx,
      );
    })();
    // 打ち切ったあとに失敗しても、未処理の例外にしない（結果は捨てる）
    run.catch(() => {});
    let outcome: Outcome;
    try {
      outcome = await Promise.race([
        run,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(timeout()), startedAt + deadlineMs - Date.now());
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    // 期限の確認。ここを過ぎたら、保存の完了を待って成功を返す
    if (Date.now() - startedAt > deadlineMs - CHECKPOINT_MARGIN_MS) throw timeout();
    const saved = await savePlan(db, {
      userId,
      inputText,
      existing,
      outcome,
      quotaDate: jstDate(time),
      retryAfterSeconds,
      saveBy: startedAt + deadlineMs + SAVE_MARGIN_MS,
      free,
    });
    return toPlan(saved.plan, saved.items, saved.used, time, outcome.purchaseItems);
  }

  /** 自分の計画を、状態を確かめて読む（404 → 状態の違い → 対象日を過ぎた、の順） */
  async function findPlan(userId: string, planId: number, status: 'clarifying' | 'completed') {
    const plan = await dependencies().repos.plans.findById(userId, planId);
    if (!plan) throw new AppError(404, 'NOT_FOUND', '対象が見つかりません');
    const draft = plan.draft as Draft | null;
    if (plan.status !== status || !draft || (status === 'clarifying' && !draft.pending)) {
      throw conflict(
        'STATE_MISMATCH',
        status === 'clarifying' ? '確認中の計画ではありません' : '完成した計画ではありません',
      );
    }
    if (plan.targetDate < jstDate(now())) {
      throw conflict('PLAN_EXPIRED', '対象日を過ぎた計画です。新しく作り直してください');
    }
    return plan;
  }

  app.post('/agent/plans', async (request, reply) => {
    if (!request.user) throw unauthorized();
    const userId = request.user.sub;
    limiter.consume(userId);
    const { inputText } = parseInput(CreatePlanRequest, request.body);
    try {
      const plan = await generate(userId, inputText, undefined, (planner, ctx) =>
        startPlan(planner, ctx, inputText),
      );
      return await reply.code(201).send(plan);
    } catch (error) {
      // 外部 API の失敗・時間切れ・想定外の失敗は、エラーの計画を1件残す（入力の誤り・制限では残さない）
      if (!(error instanceof AppError)) {
        // 応答を待たせない。失敗しても、入力文をログに出さない
        const values = { userId, inputText, targetDate: jstDate(now()), status: 'error' };
        void (opts.db && repositories(opts.db).plans.create(values))?.catch((e: unknown) =>
          request.log.warn(toLoggableError(e), 'failed to record the error plan'),
        );
      }
      throw error;
    }
  });

  app.get('/agent/plans/:planId', async (request) => {
    if (!request.user) throw unauthorized();
    const { repos } = dependencies();
    const { planId } = parseInput(PlanId, request.params);
    const plan = await repos.plans.findById(request.user.sub, planId);
    if (!plan) throw new AppError(404, 'NOT_FOUND', '対象が見つかりません');
    const time = now();
    if (plan.status === 'clarifying' && plan.draft) {
      // 確認の一覧には、いまの設定で使えない予定（同意 OFF・スキップ）を出さない
      const draft = structuredClone(plan.draft) as Draft;
      reconcile(draft, await loadContext(repos, NO_CALENDAR, request.user.sub, time));
      plan.draft = draft;
    }
    const [items, used] = await Promise.all([
      repos.planItems.listByPlan(plan.id),
      repos.generationQuotas.getUsedCount(request.user.sub, jstDate(time)),
    ]);
    return toPlan(plan, items, used, time);
  });

  app.post('/agent/plans/:planId/clarify', async (request) => {
    if (!request.user) throw unauthorized();
    const userId = request.user.sub;
    limiter.consume(userId);
    const startedAt = Date.now();
    const { planId } = parseInput(PlanId, request.params);
    const { token, ...answer } = parseInput(ClarifyRequest, request.body);
    const plan = await findPlan(userId, planId, 'clarifying');
    if (token !== (plan.draft as Draft).rev)
      throw conflict('TOKEN_MISMATCH', '回答する確認が、最新のものと違います');
    return generate(
      userId,
      plan.inputText,
      plan,
      (planner, ctx) => answerPlan(planner, ctx, plan, answer),
      startedAt,
    );
  });

  app.post('/agent/plans/:planId/revise', async (request) => {
    if (!request.user) throw unauthorized();
    const userId = request.user.sub;
    limiter.consume(userId);
    const startedAt = Date.now();
    const { planId } = parseInput(PlanId, request.params);
    const revision = parseInput(ReviseRequest, request.body);
    const plan = await findPlan(userId, planId, 'completed');
    return generate(
      userId,
      plan.inputText,
      plan,
      (planner, ctx) => revisePlan(planner, ctx, plan, revision),
      startedAt,
    );
  });

  app.delete('/agent/plans/:planId/items/:itemId', async (request) => {
    if (!request.user) throw unauthorized();
    const userId = request.user.sub;
    limiter.consume(userId);
    const startedAt = Date.now();
    const { planId, itemId } = parseInput(ItemId, request.params);
    const plan = await findPlan(userId, planId, 'completed');
    const items = await dependencies().repos.planItems.listByPlan(plan.id);
    const item = items.find((i) => i.id === itemId);
    if (!item) throw new AppError(404, 'NOT_FOUND', '対象が見つかりません');
    return generate(
      userId,
      plan.inputText,
      plan,
      (planner, ctx) => removeItem(planner, ctx, plan, item.sourceId),
      startedAt,
      true,
    );
  });

  // 準備のみ（延期の再計画・出発の検知）。入力を検証して 501 を返す。
  // Feature Flag（FEATURE_POSTPONE_REPLAN・FEATURE_DEPARTURE_DETECTION）が ON のときの処理は、まだ無い
  app.post('/agent/plans/:planId/replan', async (request) => {
    if (!request.user) throw unauthorized();
    parseInput(PlanId, request.params);
    parseInput(ReplanRequest, request.body);
    throw featureDisabled();
  });

  app.post('/agent/plans/:planId/departure-detected', async (request) => {
    if (!request.user) throw unauthorized();
    parseInput(PlanId, request.params);
    parseInput(DepartureDetectedRequest, request.body);
    throw featureDisabled();
  });
}
