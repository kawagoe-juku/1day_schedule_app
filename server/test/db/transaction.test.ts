/**
 * トランザクションと退会の確認。実際にコミットするので、useTestDb（テストごとの巻き戻し）は使わず、
 * このファイル専用の利用者 ID を使って、終わったら消す。
 */
import { like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbConnection } from '../../src/db/client.js';
import { repositories } from '../../src/db/repositories/index.js';
import { user } from '../../src/db/schema.js';
import { testDatabaseUrl } from '../helpers/test-db.js';

const U1 = 'tx-test-user-1';
const U2 = 'tx-test-user-2';

let conn: DbConnection;
beforeAll(() => {
  conn = createDb(testDatabaseUrl(), { maxConnections: 3 });
});
afterEach(async () => {
  await conn.db.delete(user).where(like(user.id, 'tx-test-%'));
});
afterAll(async () => {
  await conn.close();
});

/** 利用者に、全種類の関連データを1件ずつ持たせる */
async function seedEverything(userId: string): Promise<number> {
  const repos = repositories(conn.db);
  await repos.users.ensure(userId);
  const plan = await repos.plans.create({ userId, inputText: '用事', targetDate: '2026-11-10' });
  const time = new Date('2026-11-10T13:00:00+09:00');
  await repos.planItems.insertMany([
    {
      planId: plan.id,
      sequence: 1,
      slotType: 'DEPARTURE',
      itemType: 'departure',
      title: '出発',
      startTime: time,
      endTime: time,
    },
  ]);
  await repos.slotEvaluations.insertMany([
    { planId: plan.id, slotType: 'MAIN', slotName: '用事', evaluationOrder: 1, isEvaluated: true },
  ]);
  await repos.agentSessions.insert({
    planId: plan.id,
    sessionType: 'compose',
    inputSummary: '入力',
    outputSummary: '出力',
  });
  await repos.departureLogs.insert({
    userId,
    planId: plan.id,
    plannedDepartureTime: time,
    actualDepartureTime: time,
    preparationTimeMinutes: 30,
  });
  await repos.routines.create({ userId, routineName: 'ジム' });
  await repos.memos.create({ userId, memoText: '牛乳' });
  const integration = await repos.calendarIntegrations.upsert({
    userId,
    provider: 'google',
    secretName: `integration/${userId}/google`,
  });
  await repos.calendarEvents.upsertMany([
    {
      userId,
      calendarIntegrationId: integration.id,
      externalEventId: 'e1',
      eventTitle: '定例',
      eventDate: '2026-11-10',
      startTime: time,
      endTime: time,
    },
  ]);
  await repos.pointPrograms.set(userId, 'ponta', true);
  await repos.generationQuotas.increment(userId, '2026-11-10');
  return plan.id;
}

/** 利用者に紐づく行の合計（全テーブル） */
async function countRows(userId: string, planId: number): Promise<number> {
  const repos = repositories(conn.db);
  const counts = await Promise.all([
    repos.users.findById(userId).then((u) => (u ? 1 : 0)),
    repos.plans.listByUser(userId).then((r) => r.length),
    repos.planItems.listByPlan(planId).then((r) => r.length),
    repos.slotEvaluations.listByPlan(planId).then((r) => r.length),
    repos.agentSessions.listByPlan(planId).then((r) => r.length),
    repos.departureLogs.listByUser(userId).then((r) => r.length),
    repos.routines.listByUser(userId).then((r) => r.length),
    repos.memos.listByUser(userId).then((r) => r.length),
    repos.calendarIntegrations.listByUser(userId).then((r) => r.length),
    repos.calendarEvents.listByUserAndDate(userId, '2026-11-10').then((r) => r.length),
    repos.pointPrograms.listByUser(userId).then((r) => r.length),
    repos.generationQuotas.getUsedCount(userId, '2026-11-10'),
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

describe('トランザクション', () => {
  it('ping で接続を確認できる', async () => {
    expect(await conn.ping()).toBe(true);
  });

  it('複数のリポジトリの操作をまとめて確定できる', async () => {
    await conn.db.transaction(async (tx) => {
      const repos = repositories(tx);
      await repos.users.ensure(U1);
      await repos.memos.create({ userId: U1, memoText: '牛乳' });
      await repos.routines.create({ userId: U1, routineName: 'ジム' });
    });
    const repos = repositories(conn.db);
    expect(await repos.memos.listByUser(U1)).toHaveLength(1);
    expect(await repos.routines.listByUser(U1)).toHaveLength(1);
  });

  it('途中で失敗すると、それまでの操作もすべて取り消される', async () => {
    await repositories(conn.db).users.ensure(U1);
    await expect(
      conn.db.transaction(async (tx) => {
        const repos = repositories(tx);
        await repos.memos.create({ userId: U1, memoText: '牛乳' });
        await repos.users.update(U1, { walkingSpeed: 'fast' });
        // 存在しない利用者のメモは外部キー制約で失敗する
        await repos.memos.create({ userId: 'tx-test-nobody', memoText: 'x' });
      }),
    ).rejects.toThrow();
    const repos = repositories(conn.db);
    expect(await repos.memos.listByUser(U1)).toEqual([]);
    expect((await repos.users.findById(U1))?.walkingSpeed).toBe('normal');
  });

  it('確定前の変更は、他の接続からは見えない', async () => {
    await conn.db.transaction(async (tx) => {
      await repositories(tx).users.ensure(U1);
      expect(await repositories(conn.db).users.findById(U1)).toBeUndefined();
    });
    expect(await repositories(conn.db).users.findById(U1)).toBeDefined();
  });
});

describe('退会（単一トランザクション）', () => {
  it('利用者を消すと、その人のデータが全テーブルから消え、他の利用者のデータは残る', async () => {
    const plan1 = await seedEverything(U1);
    const plan2 = await seedEverything(U2);
    expect(await countRows(U1, plan1)).toBe(12);

    const deleted = await conn.db.transaction((tx) => repositories(tx).users.delete(U1));

    expect(deleted).toBe(true);
    expect(await countRows(U1, plan1)).toBe(0);
    expect(await countRows(U2, plan2)).toBe(12);
  });

  it('退会の途中で失敗すると、データは1件も消えない', async () => {
    const plan1 = await seedEverything(U1);
    await expect(
      conn.db.transaction(async (tx) => {
        await repositories(tx).users.delete(U1);
        // 退会処理の後続（Cognito の利用者削除など）が失敗した場合を想定
        throw new Error('後続の処理に失敗');
      }),
    ).rejects.toThrow('後続の処理に失敗');
    expect(await countRows(U1, plan1)).toBe(12);
  });
});
