/**
 * 計画の API（/agent/plans）を、実際の DB で確かめる。AI・Google Maps は代用品。
 * 保存は実際にコミットするので、useTestDb（テストごとの巻き戻し）は使わず、
 * このファイル専用の利用者 ID を使って、終わったら消す。
 */
import { eq, like, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExternalApiError } from '../../src/adapters/http.js';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb, type DbConnection } from '../../src/db/client.js';
import { repositories } from '../../src/db/repositories/index.js';
import { plan as planTable, user } from '../../src/db/schema.js';
import type { PlanRouteOptions } from '../../src/routes/plans.js';
import { SLOT_IDS } from '../../src/agent/slots.js';
import {
  errand,
  fakeAi,
  fakeMaps,
  fakeNavitime,
  HOME,
  INPUT,
  intent,
  NOW,
} from '../helpers/agent-fakes.js';
import { schemaErrors } from '../helpers/openapi.js';
import { fakeVerifier } from '../helpers/route-app.js';
import { testDatabaseUrl } from '../helpers/test-db.js';

const config = loadConfig({ NODE_ENV: 'test' });
const U1 = 'plan-test-user-1';
const U2 = 'plan-test-user-2';
const auth = (userId = U1) => ({ authorization: `Bearer token-${userId}` });
const TODAY = '2026-11-25';
/** 終了の時刻が無いので、質問が1回入る入力 */
const NEEDS_QUESTION = intent({ errands: [errand({ endTime: null })] });
const PATCH = { place: null, placeIsSpecific: true, startTime: null, endTime: '15:00' };

let conn: DbConnection;
let app: FastifyInstance | undefined;
beforeAll(() => {
  conn = createDb(testDatabaseUrl(), { maxConnections: 5 });
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await conn.db.delete(user).where(like(user.id, 'plan-test-%'));
});
afterAll(async () => {
  await conn.close();
});

async function seedUser(userId = U1, home: typeof HOME | null = HOME) {
  const repos = repositories(conn.db);
  await repos.users.ensure(userId);
  if (home) await repos.users.update(userId, { homeLatitude: home.lat, homeLongitude: home.lng });
}

async function setup(
  answers: Parameters<typeof fakeAi>[0] = {},
  options: Partial<PlanRouteOptions> = {},
) {
  await seedUser();
  const { ai, calls } = fakeAi(answers);
  const { maps } = fakeMaps();
  app = await buildApp({
    config,
    verifier: fakeVerifier,
    plans: {
      db: conn.db,
      ai,
      googleMaps: maps,
      navitime: fakeNavitime,
      now: () => NOW,
      ...options,
    },
    logger: false,
  });
  const server = app;
  const post = (inputText = INPUT, userId = U1) =>
    server.inject({
      method: 'POST',
      url: '/agent/plans',
      headers: auth(userId),
      payload: { inputText },
    });
  const clarify = (planId: number, payload: Record<string, unknown>, userId = U1) =>
    server.inject({
      method: 'POST',
      url: `/agent/plans/${planId}/clarify`,
      headers: auth(userId),
      payload,
    });
  const get = (planId: number, userId = U1) =>
    server.inject({ method: 'GET', url: `/agent/plans/${planId}`, headers: auth(userId) });
  const call = (method: 'POST' | 'DELETE', path: string, payload?: unknown, userId = U1) =>
    server.inject({
      method,
      url: `/agent/plans/${path}`,
      headers: auth(userId),
      ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    });
  return { post, clarify, get, call, calls, repos: repositories(conn.db) };
}
const plansOf = (userId = U1) =>
  conn.db.select().from(planTable).where(eq(planTable.userId, userId));

describe('POST /agent/plans', () => {
  it('計画を完成させて保存する（計画・行動項目・スロット評価・対話の記録・生成回数）', async () => {
    const { post, get, repos } = await setup();
    const response = await post();
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      status: 'completed',
      inputText: INPUT,
      targetDate: TODAY,
      clarification: null,
      purchaseItems: [{ sourceId: 's2', items: ['カレーの食材'] }],
      warnings: [],
      quota: { used: 1, limit: 20, resetAt: '2026-11-26T00:00:00+09:00' },
    });
    expect(schemaErrors('Plan', body)).toEqual([]);
    expect(body.departureTime).toBe('2026-11-25T12:20:00+09:00');
    expect(body.items.map((i: { sequence: number }) => i.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(body.items[1]).toMatchObject({
      itemType: 'move',
      slotType: 'OUTBOUND',
      title: '電車で東京駅へ',
      transportMode: 'train',
      startTime: '2026-11-25T12:20:00+09:00',
      endTime: '2026-11-25T12:50:00+09:00',
      route: {
        durationMinutes: 30,
        steps: [{ lineName: 'サンプル線', fromStation: '三軒茶屋', toStation: '東京' }],
      },
    });
    expect(body.items[4]).toMatchObject({
      itemType: 'stopover',
      sourceId: 's2',
      store: { name: 'サンプルスーパー自宅前店' },
    });

    const evaluations = await repos.slotEvaluations.listByPlan(body.id);
    expect(evaluations.map((e) => [e.evaluationOrder, e.slotType, e.isEvaluated])).toEqual(
      ['MAIN', 'MAIN', 'OUTBOUND', 'OUTBOUND', 'DEPARTURE', 'RETURN', 'RETURN'].map((type, i) => [
        i + 1,
        type,
        true,
      ]),
    );
    expect(evaluations).toHaveLength(SLOT_IDS.length);
    const sessions = await repos.agentSessions.listByPlan(body.id);
    expect(sessions.map((s) => s.sessionType)).toEqual(['intent', 'compose']);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(1);

    // 保存した内容に、品目・プロンプトを残さない（入力文は plan.input_text にだけ残る）
    const [row] = await plansOf();
    expect(JSON.stringify([row?.draft, sessions, evaluations])).not.toMatch(/カレー|読み取り係/);

    // 取得では、品目は返さない
    const fetched = (await get(body.id)).json();
    expect(fetched).toMatchObject({ id: body.id, status: 'completed' });
    expect(fetched.items).toEqual(body.items);
    expect(fetched.purchaseItems).toBeUndefined();
  });

  it('確認で止まるときは、下書きを保存して確認を返す。生成回数は数えない', async () => {
    const { post, get, repos } = await setup({ interpret: NEEDS_QUESTION });
    const response = await post();
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      status: 'clarifying',
      items: [],
      purchaseItems: [{ sourceId: 's2', items: ['カレーの食材'] }],
      clarification: {
        kind: 'question',
        token: 1,
        question: '「待ち合わせ」について、何時ごろまでかを教えてください',
        count: 1,
        maxCount: 2,
        options: [],
        allowFreeText: true,
      },
      quota: { used: 0 },
    });
    expect(schemaErrors('Plan', body)).toEqual([]);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(0);
    expect((await get(body.id)).json().clarification).toEqual(body.clarification);
  });

  it('入力の検証：空・501文字以上・余分な項目は 400。未認証は 401', async () => {
    const { post, calls } = await setup();
    expect((await post('')).statusCode).toBe(400);
    expect((await post('あ'.repeat(501))).statusCode).toBe(400);
    const extra = await app!.inject({
      method: 'POST',
      url: '/agent/plans',
      headers: auth(),
      payload: { inputText: INPUT, userId: U2 },
    });
    expect(extra.statusCode).toBe(400);
    const anonymous = await app!.inject({ method: 'POST', url: '/agent/plans', payload: {} });
    expect(anonymous.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await plansOf()).toHaveLength(0);
  });

  it('不適切な入力（AI の判定）は 400 で、計画を作らない', async () => {
    const { post } = await setup({ interpret: intent({ rejected: true, errands: [], stops: [] }) });
    const response = await post();
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details[0].field).toBe('inputText');
    expect(await plansOf()).toHaveLength(0);
  });

  it('自宅が未設定なら 409（HOME_NOT_SET）。AI を呼ばない', async () => {
    const { post, calls, repos } = await setup();
    await repos.users.update(U1, { homeLatitude: null, homeLongitude: null });
    const response = await post();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'CONFLICT',
      details: [{ field: 'HOME_NOT_SET' }],
    });
    expect(calls).toHaveLength(0);
    expect(await plansOf()).toHaveLength(0);
  });

  it('Bedrock の失敗は 502。エラーの計画を1件だけ残し、生成回数は数えない', async () => {
    const { post, repos } = await setup({
      interpret: new ExternalApiError('bedrock', 'interpret', 'timeout'),
    });
    const response = await post();
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('EXTERNAL_SERVICE_ERROR');
    // エラーの計画は、応答を待たせずに作る
    await vi.waitFor(async () => {
      const rows = await plansOf();
      expect(rows.map((r) => [r.status, r.targetDate, r.draft])).toEqual([['error', TODAY, null]]);
    });
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(0);
  });

  it('期限を過ぎたら 502 で打ち切り、生成回数は数えない', async () => {
    const slow = intent();
    const { ai } = fakeAi({ interpret: slow });
    const { post, repos } = await setup(
      {},
      {
        deadlineMs: 600,
        ai: {
          callTool: async (call) => {
            await new Promise((resolve) => setTimeout(resolve, 900));
            return ai.callTool(call);
          },
        },
      },
    );
    const startedAt = Date.now();
    const response = await post();
    expect(response.statusCode).toBe(502);
    expect(Date.now() - startedAt).toBeLessThan(850);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(0);
    await vi.waitFor(async () => expect((await plansOf()).map((r) => r.status)).toEqual(['error']));
  });

  it('その日の生成が 20 回に達していれば 429。外部 API を呼ばない', async () => {
    const { post, calls, repos } = await setup();
    for (let i = 0; i < 20; i++) await repos.generationQuotas.increment(U1, TODAY);
    const response = await post();
    expect(response.statusCode).toBe(429);
    // 日本時間 0 時まで（現在は 09:00）
    expect(response.headers['retry-after']).toBe(String(15 * 3600));
    expect(calls).toHaveLength(0);
    expect(await plansOf()).toHaveLength(0);
  });

  it('同時に生成しても、20 回を超えない（超えた分は取り消して 429）', async () => {
    const { post, repos } = await setup();
    for (let i = 0; i < 19; i++) await repos.generationQuotas.increment(U1, TODAY);
    const responses = await Promise.all([post(), post(), post()]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 429, 429]);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(20);
    expect((await plansOf()).map((r) => r.status)).toEqual(['completed']);
  });

  it('1分に 11 回目の要求は 429', async () => {
    const { post } = await setup({ interpret: intent({ rejected: true, errands: [], stops: [] }) });
    for (let i = 0; i < 10; i++) expect((await post()).statusCode).toBe(400);
    const response = await post();
    expect(response.statusCode).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('GET /agent/plans/{planId}', () => {
  it('他の利用者の計画・無い計画は 404。ID の形式が違えば 400', async () => {
    const { post, get } = await setup();
    await seedUser(U2);
    const { id } = (await post()).json();
    expect((await get(id, U2)).statusCode).toBe(404);
    expect((await get(999_999_999)).statusCode).toBe(404);
    const invalid = await app!.inject({ method: 'GET', url: '/agent/plans/abc', headers: auth() });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('確認中の計画と、設定の変更', () => {
  it('ルーティンを消したあとは、取得する一覧に出さない。回答しても計画に入らない', async () => {
    const { post, get, clarify, repos } = await setup();
    const routine = await repos.routines.create({
      userId: U1,
      routineName: 'ジム',
      locationName: '新宿駅',
      startTime: '19:00',
      endTime: '20:00',
    });
    const first = (await post()).json();
    const labels = async () =>
      (await get(first.id)).json().clarification.options.map((o: { label: string }) => o.label);
    expect(await labels()).toEqual(['待ち合わせ', 'ジム', 'スーパー']);

    await repos.routines.delete(U1, routine.id);
    expect(await labels()).toEqual(['待ち合わせ', 'スーパー']);
    // 消えた予定の ID を選んだ回答は 400
    expect((await clarify(first.id, { token: 1, selectedIds: ['e1', 'e2'] })).statusCode).toBe(400);
    expect((await clarify(first.id, { token: 1, selectedIds: ['e1'] })).statusCode).toBe(200);
  });

  it('回答のときは、カレンダーを取り直さない', async () => {
    let reads = 0;
    const { post, clarify, repos } = await setup(
      { interpret: NEEDS_QUESTION, patch: PATCH },
      {
        calendar: {
          list: async () => {
            reads += 1;
            throw new Error('503');
          },
        },
      },
    );
    await repos.users.update(U1, { calendarUsageConsent: true });
    const first = (await post()).json();
    expect(reads).toBe(1);
    const done = (await clarify(first.id, { token: 1, answer: '15時まで' })).json();
    expect(reads).toBe(1);
    // 作り始めたときに取得できなかった注意は、完成した計画にも残す
    expect(done.warnings).toEqual([
      'カレンダーの予定を取得できなかったため、予定なしで計画を作りました',
    ]);
  });
});

describe('POST /agent/plans/{planId}/clarify', () => {
  it('回答して計画を完成させる。完成したときに、生成回数を数える', async () => {
    const { post, clarify, repos } = await setup({ interpret: NEEDS_QUESTION, patch: PATCH });
    const first = (await post()).json();
    const response = await clarify(first.id, {
      token: first.clarification.token,
      answer: '15時まで',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: first.id,
      status: 'completed',
      clarification: null,
      quota: { used: 1 },
    });
    expect(body.purchaseItems).toBeUndefined();
    expect(body.items.find((i: { sourceId?: string }) => i.sourceId === 'e1')).toMatchObject({
      endTime: '2026-11-25T15:00:00+09:00',
    });
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(1);
    expect((await repos.agentSessions.listByPlan(first.id)).map((s) => s.sessionType)).toEqual([
      'intent',
      'clarify',
      'clarify',
      'compose',
    ]);
    expect(await plansOf()).toHaveLength(1);
  });

  it('予定の一覧 → 回答 → 完成（一覧は質問の回数に数えない）', async () => {
    const { post, clarify, repos } = await setup();
    await repos.routines.create({
      userId: U1,
      routineName: 'ジム',
      locationName: '新宿駅',
      startTime: '19:00',
      endTime: '20:00',
    });
    const first = (await post()).json();
    expect(first.clarification).toMatchObject({
      kind: 'selection',
      count: 0,
      allowFreeText: false,
    });
    expect(schemaErrors('Plan', first)).toEqual([]);
    expect(first.clarification.options.map((o: { id: string }) => o.id)).toEqual([
      'e1',
      'e2',
      's3',
    ]);

    const done = await clarify(first.id, { token: first.clarification.token, selectedIds: ['e1'] });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'completed' });
    expect(done.json().items.some((i: { title: string }) => i.title === 'ジム')).toBe(false);
  });

  it('保存が期限までに終わらなければ、取り消して 502。生成回数は数えず、やり直せる', async () => {
    const { post, clarify, repos } = await setup(
      { interpret: NEEDS_QUESTION, patch: PATCH },
      // 保存の期限は、その 1 秒後
      { deadlineMs: 800 },
    );
    const first = (await post()).json();
    const answer = { token: first.clarification.token, answer: '15時まで' };
    // 別の取引が計画の行を掴んでいる間は、保存が待たされる
    const response = await conn.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from plan where id = ${first.id} for update`);
      return clarify(first.id, answer);
    });
    expect(response.statusCode).toBe(502);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(0);
    expect(await plansOf()).toMatchObject([{ status: 'clarifying' }]);
    expect((await clarify(first.id, answer)).json()).toMatchObject({ status: 'completed' });
  });

  it('409：確認の番号が違う／確認中でない／対象日を過ぎた', async () => {
    const { post, clarify, repos } = await setup({ interpret: NEEDS_QUESTION, patch: PATCH });
    const first = (await post()).json();
    const reason = async (payload: Record<string, unknown>) => {
      const response = await clarify(first.id, payload);
      expect(response.statusCode).toBe(409);
      return response.json().error.details[0].field as string;
    };
    expect(await reason({ token: 99, answer: '15時まで' })).toBe('TOKEN_MISMATCH');

    await conn.db
      .update(planTable)
      .set({ targetDate: '2026-11-24' })
      .where(eq(planTable.id, first.id));
    expect(await reason({ token: 1, answer: '15時まで' })).toBe('PLAN_EXPIRED');
    await conn.db.update(planTable).set({ targetDate: TODAY }).where(eq(planTable.id, first.id));

    expect((await clarify(first.id, { token: 1, answer: '15時まで' })).statusCode).toBe(200);
    // 再送された回答は、次の処理に入らない
    expect(await reason({ token: 1, answer: '15時まで' })).toBe('STATE_MISMATCH');
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(1);
  });

  it('他の利用者の計画には回答できない（404）。入力の誤りは 400', async () => {
    const { post, clarify } = await setup({ interpret: NEEDS_QUESTION, patch: PATCH });
    await seedUser(U2);
    const first = (await post()).json();
    expect((await clarify(first.id, { token: 1, answer: 'a' }, U2)).statusCode).toBe(404);
    expect((await clarify(first.id, { answer: 'a' })).statusCode).toBe(400);
    expect((await clarify(first.id, { token: 1 })).statusCode).toBe(400);
    expect((await clarify(first.id, { token: 1, answer: 'a', extra: 1 })).statusCode).toBe(400);
  });

  it('回答の処理が失敗しても、計画の状態は変わらない（やり直せる）', async () => {
    let fail = true;
    const { post, clarify } = await setup({
      interpret: NEEDS_QUESTION,
      patch: PATCH,
      decide: (data) => {
        if (fail) return new ExternalApiError('bedrock', 'decide', 'timeout');
        return {
          slots: SLOT_IDS.map((slot) => ({ slot, decision: '問題なし' })),
          stopovers: data.candidates.slice(0, 1).map((c) => ({
            stopId: c.stopId,
            candidate: c.candidate,
            when: c.when[0],
          })),
        };
      },
    });
    const first = (await post()).json();
    const failed = await clarify(first.id, { token: 1, answer: '15時まで' });
    expect(failed.statusCode).toBe(502);
    const [row] = await plansOf();
    expect(row).toMatchObject({ status: 'clarifying', clarificationCount: 1 });
    expect(await plansOf()).toHaveLength(1);

    fail = false;
    expect((await clarify(first.id, { token: 1, answer: '15時まで' })).statusCode).toBe(200);
  });

  it('同じ確認に同時に回答しても、反映されるのは1つだけ（項目は重複しない）', async () => {
    const { post, clarify, repos } = await setup({ interpret: NEEDS_QUESTION, patch: PATCH });
    const first = (await post()).json();
    const responses = await Promise.all([
      clarify(first.id, { token: 1, answer: '15時まで' }),
      clarify(first.id, { token: 1, answer: '15時まで' }),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const conflict = responses.find((r) => r.statusCode === 409);
    expect(conflict?.json().error.details[0].field).toBe('CONCURRENT_UPDATE');
    const done = responses.find((r) => r.statusCode === 200);
    expect(await repos.planItems.listByPlan(first.id)).toHaveLength(done?.json().items.length);
    expect(await repos.slotEvaluations.listByPlan(first.id)).toHaveLength(SLOT_IDS.length);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(1);
  });
});

describe('POST /agent/plans/{planId}/revise', () => {
  const REVISED = intent({ errands: [errand({ id: 'e1' })], stops: [], removedIds: ['s2'] });
  const body = {
    instruction: '買い物はやめる',
    purchaseItems: [{ sourceId: 's2', items: ['米'] }],
  };

  it('計画を作り直して入れ替える（項目は重複しない）。生成回数を1回数える', async () => {
    const { post, call, repos } = await setup({ revise: REVISED });
    const first = (await post()).json();
    const response = await call('POST', `${first.id}/revise`, body);
    expect(response.statusCode).toBe(200);
    const plan = response.json();
    expect(schemaErrors('Plan', plan)).toEqual([]);
    expect(plan).toMatchObject({ id: first.id, status: 'completed', quota: { used: 2 } });
    expect(plan.items.map((i: { itemType: string }) => i.itemType)).toEqual([
      'departure',
      'move',
      'errand',
      'move',
      'return',
    ]);
    expect(await repos.planItems.listByPlan(first.id)).toHaveLength(5);
    expect(await repos.slotEvaluations.listByPlan(first.id)).toHaveLength(SLOT_IDS.length);
    expect((await repos.agentSessions.listByPlan(first.id)).map((s) => s.sessionType)).toEqual([
      'intent',
      'compose',
      'intent',
      'compose',
    ]);
    expect(await plansOf()).toHaveLength(1);
  });

  it('確認中の計画は 409（STATE_MISMATCH）。他の利用者の計画は 404。入力の誤りは 400', async () => {
    const { post, call } = await setup({ interpret: NEEDS_QUESTION });
    const first = (await post()).json();
    const mismatch = await call('POST', `${first.id}/revise`, body);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.details[0].field).toBe('STATE_MISMATCH');
    await seedUser(U2);
    expect((await call('POST', `${first.id}/revise`, body, U2)).statusCode).toBe(404);
    for (const payload of [{}, { instruction: ' ' }, { instruction: 'a', extra: 1 }]) {
      expect((await call('POST', `${first.id}/revise`, payload)).statusCode).toBe(400);
    }
  });

  it('失敗したときは、計画を変えず、エラーの計画も作らない。生成回数も数えない', async () => {
    const { post, call, get, repos } = await setup({
      revise: new ExternalApiError('bedrock', 'revise', 'timeout'),
    });
    const first = (await post()).json();
    expect((await call('POST', `${first.id}/revise`, body)).statusCode).toBe(502);
    expect((await get(first.id)).json()).toMatchObject({ status: 'completed', items: first.items });
    expect(await plansOf()).toHaveLength(1);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(1);
  });

  it('同時に修正しても、反映されるのは1つだけ（項目は重複しない）', async () => {
    const { post, call, repos } = await setup({ revise: REVISED });
    const first = (await post()).json();
    const responses = await Promise.all([
      call('POST', `${first.id}/revise`, body),
      call('POST', `${first.id}/revise`, body),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await repos.planItems.listByPlan(first.id)).toHaveLength(5);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(2);
  });

  it('その日の生成が 20 回に達していれば 429', async () => {
    const { post, call, repos } = await setup({ revise: REVISED });
    const first = (await post()).json();
    for (let i = 1; i < 20; i++) await repos.generationQuotas.increment(U1, TODAY);
    expect((await call('POST', `${first.id}/revise`, body)).statusCode).toBe(429);
  });
});

describe('DELETE /agent/plans/{planId}/items/{itemId}', () => {
  type Item = { id: number; itemType: string };
  const idOf = (plan: { items: Item[] }, type: string) =>
    plan.items.find((i) => i.itemType === type)?.id;

  it('立寄りを削除して作り直す。生成回数は数えず、AI を呼ばない', async () => {
    const { post, call, calls, repos } = await setup();
    const first = (await post()).json();
    calls.length = 0;
    const response = await call('DELETE', `${first.id}/items/${idOf(first, 'stopover')}`);
    expect(response.statusCode).toBe(200);
    const plan = response.json();
    expect(schemaErrors('Plan', plan)).toEqual([]);
    expect(plan.items.map((i: Item) => i.itemType)).toEqual([
      'departure',
      'move',
      'errand',
      'move',
      'return',
    ]);
    expect(plan.purchaseItems).toBeUndefined();
    expect(plan.quota.used).toBe(1);
    expect(calls).toEqual([]);
    expect(await repos.planItems.listByPlan(first.id)).toHaveLength(5);
    expect(await repos.generationQuotas.getUsedCount(U1, TODAY)).toBe(1);
  });

  it('1日の上限に達していても、削除はできる', async () => {
    const { post, call, repos } = await setup();
    const first = (await post()).json();
    for (let i = 1; i < 20; i++) await repos.generationQuotas.increment(U1, TODAY);
    const response = await call('DELETE', `${first.id}/items/${idOf(first, 'stopover')}`);
    expect(response.statusCode).toBe(200);
  });

  it('409（NOT_DELETABLE）：出発・移動・帰宅の項目／何も残らなくなる削除。計画は変わらない', async () => {
    const { post, call, get } = await setup({ interpret: intent({ stops: [] }) });
    const first = (await post()).json();
    for (const type of ['departure', 'move', 'return', 'errand']) {
      const response = await call('DELETE', `${first.id}/items/${idOf(first, type)}`);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.details[0].field).toBe('NOT_DELETABLE');
    }
    expect((await get(first.id)).json().items).toEqual(first.items);
  });

  it('無い項目・他の計画の項目・他の利用者は 404。ID の形式が違えば 400', async () => {
    const { post, call } = await setup();
    const first = (await post()).json();
    const second = (await post()).json();
    const item = idOf(first, 'stopover');
    expect((await call('DELETE', `${first.id}/items/999999999`)).statusCode).toBe(404);
    expect((await call('DELETE', `${second.id}/items/${item}`)).statusCode).toBe(404);
    await seedUser(U2);
    expect((await call('DELETE', `${first.id}/items/${item}`, undefined, U2)).statusCode).toBe(404);
    expect((await call('DELETE', `${first.id}/items/abc`)).statusCode).toBe(400);
  });
});

describe('準備のみの API（replan・departure-detected）', () => {
  it('入力を検証して、501（FEATURE_DISABLED）を返す。計画の存在は確かめない', async () => {
    const { call } = await setup();
    const replan = await call('POST', '1/replan', { delayMinutes: 30 });
    expect(replan.statusCode).toBe(501);
    expect(replan.json().error.code).toBe('FEATURE_DISABLED');
    const departed = await call('POST', '1/departure-detected', {
      actualDepartureTime: '2026-11-25T12:20:00+09:00',
    });
    expect(departed.statusCode).toBe(501);
    expect((await call('POST', '1/replan', { delayMinutes: 0 })).statusCode).toBe(400);
    expect((await call('POST', '1/replan', { delayMinutes: 241 })).statusCode).toBe(400);
    const bad = await call('POST', '1/departure-detected', { actualDepartureTime: '12:20' });
    expect(bad.statusCode).toBe(400);
    expect((await call('POST', 'abc/replan', { delayMinutes: 30 })).statusCode).toBe(400);
  });
});
