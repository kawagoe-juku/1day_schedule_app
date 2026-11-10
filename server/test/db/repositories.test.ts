import { describe, expect, it } from 'vitest';
import { repositories } from '../../src/db/repositories/index.js';
import { useTestDb } from '../helpers/test-db.js';

const U1 = 'sub-user-1';
const U2 = 'sub-user-2';
const at = (iso: string) => new Date(iso);

describe('リポジトリ', () => {
  const { db, client } = useTestDb();
  const repos = () => repositories(db());
  /** 利用者2人を用意する */
  const seedUsers = async () => {
    await repos().users.ensure(U1);
    await repos().users.ensure(U2);
  };
  const newPlan = (userId: string) =>
    repos().plans.create({ userId, inputText: '14時に渋谷で打ち合わせ', targetDate: '2026-11-10' });

  describe('user', () => {
    it('ensure は既定値で作り、2回目は同じ行を返す（上書きしない）', async () => {
      const created = await repos().users.ensure(U1);
      expect(created).toMatchObject({ id: U1, walkingSpeed: 'normal', onboardingCompleted: false });
      await repos().users.update(U1, { walkingSpeed: 'fast' });
      expect((await repos().users.ensure(U1)).walkingSpeed).toBe('fast');
    });

    it('update は指定した項目だけ変え、updated_at を進める', async () => {
      const before = await repos().users.ensure(U1);
      // 同じトランザクションの中では now() が進まないので、作成日時を過去にしておく
      await client().query(`update "user" set updated_at = now() - interval '1 hour'`);
      const updated = await repos().users.update(U1, {
        homeAddress: '東京都渋谷区',
        homeLatitude: 35.658,
        homeLongitude: 139.701,
        frequentlyUsedStations: [{ stationCode: '00001', stationName: '渋谷', label: '最寄り' }],
        onboardingCompleted: true,
        termsAcceptedAt: at('2026-11-10T09:00:00+09:00'),
      });
      expect(updated).toMatchObject({
        homeAddress: '東京都渋谷区',
        preparationTimeMinutes: 30,
        onboardingCompleted: true,
        frequentlyUsedStations: [{ stationCode: '00001', stationName: '渋谷', label: '最寄り' }],
      });
      expect(updated?.termsAcceptedAt?.toISOString()).toBe('2026-11-10T00:00:00.000Z');
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime() - 3600_000);
      const raw = await client().query(
        `select updated_at > now() - interval '1 minute' as ok from "user"`,
      );
      expect(raw.rows[0]?.ok).toBe(true);
    });

    it('無い利用者は undefined／false', async () => {
      expect(await repos().users.findById('nobody')).toBeUndefined();
      expect(await repos().users.update('nobody', { walkingSpeed: 'slow' })).toBeUndefined();
      expect(await repos().users.delete('nobody')).toBe(false);
    });
  });

  describe('plan・plan_item・slot_evaluation・agent_session', () => {
    it('計画を作ると既定値（生成中・確認質問0回）で入る', async () => {
      await seedUsers();
      const plan = await newPlan(U1);
      expect(plan).toMatchObject({
        userId: U1,
        status: 'generating',
        clarificationCount: 0,
        targetDate: '2026-11-10',
        departureTime: null,
        assumptions: [],
        warnings: [],
      });
    });

    it('他の利用者の計画は取得・更新・削除できない', async () => {
      await seedUsers();
      const plan = await newPlan(U1);
      expect(await repos().plans.findById(U2, plan.id)).toBeUndefined();
      expect(await repos().plans.update(U2, plan.id, { status: 'completed' })).toBeUndefined();
      expect(await repos().plans.delete(U2, plan.id)).toBe(false);
      expect((await repos().plans.findById(U1, plan.id))?.status).toBe('generating');
    });

    it('更新と一覧（新しい順・件数の上限）', async () => {
      await seedUsers();
      const first = await newPlan(U1);
      const second = await newPlan(U1);
      await newPlan(U2);
      const updated = await repos().plans.update(U1, first.id, {
        status: 'clarifying',
        clarificationCount: 1,
        clarificationQuestion: '帰りに寄りたい場所はありますか？',
        assumptions: ['徒歩は標準の速さ'],
      });
      expect(updated).toMatchObject({ status: 'clarifying', assumptions: ['徒歩は標準の速さ'] });
      expect((await repos().plans.listByUser(U1)).map((p) => p.id)).toEqual([second.id, first.id]);
      expect(await repos().plans.listByUser(U1, 1)).toHaveLength(1);
    });

    it('行動項目は順序どおりに取れ、1件削除・全件入れ替えができる', async () => {
      await seedUsers();
      const plan = await newPlan(U1);
      const base = {
        planId: plan.id,
        startTime: at('2026-11-10T13:00:00+09:00'),
        endTime: at('2026-11-10T13:30:00+09:00'),
      };
      const inserted = await repos().planItems.insertMany([
        {
          ...base,
          sequence: 2,
          slotType: 'OUTBOUND',
          itemType: 'move',
          title: '渋谷へ移動',
          transportMode: 'train',
          routeDetail: { durationMinutes: 25, fareYen: 210 },
        },
        { ...base, sequence: 1, slotType: 'DEPARTURE', itemType: 'departure', title: '出発' },
        {
          ...base,
          sequence: 3,
          slotType: 'RETURN',
          itemType: 'stopover',
          title: 'スーパー',
          store: { placeId: 'p1', name: 'スーパー渋谷店', pointProgramCode: 'ponta' },
        },
      ]);
      expect(inserted).toHaveLength(3);
      const items = await repos().planItems.listByPlan(plan.id);
      expect(items.map((i) => i.title)).toEqual(['出発', '渋谷へ移動', 'スーパー']);
      expect(items[1]?.routeDetail).toEqual({ durationMinutes: 25, fareYen: 210 });
      expect(items[2]?.store?.name).toBe('スーパー渋谷店');

      const target = items[2];
      if (!target) throw new Error('項目がありません');
      expect(await repos().planItems.delete(plan.id + 999, target.id)).toBe(false);
      expect(await repos().planItems.delete(plan.id, target.id)).toBe(true);
      expect(await repos().planItems.deleteByPlan(plan.id)).toBe(2);
      expect(await repos().planItems.insertMany([])).toEqual([]);
      expect(await repos().planItems.listByPlan(plan.id)).toEqual([]);
    });

    it('スロット評価と AI 対話履歴を記録し、計画を消すと一緒に消える', async () => {
      await seedUsers();
      const plan = await newPlan(U1);
      await repos().slotEvaluations.insertMany([
        {
          planId: plan.id,
          slotType: 'MAIN',
          slotName: '用事',
          evaluationOrder: 2,
          isEvaluated: true,
        },
        {
          planId: plan.id,
          slotType: 'DEPARTURE',
          slotName: '出発',
          evaluationOrder: 1,
          isEvaluated: true,
          evaluationResult: '13:00 に出発',
        },
      ]);
      await repos().agentSessions.insert({
        planId: plan.id,
        sessionType: 'intent',
        inputSummary: '渋谷で打ち合わせ',
        outputSummary: '目的地：渋谷、到着：14時',
      });
      expect((await repos().slotEvaluations.listByPlan(plan.id)).map((s) => s.slotName)).toEqual([
        '出発',
        '用事',
      ]);
      expect(await repos().agentSessions.listByPlan(plan.id)).toHaveLength(1);

      expect(await repos().plans.delete(U1, plan.id)).toBe(true);
      expect(await repos().slotEvaluations.listByPlan(plan.id)).toEqual([]);
      expect(await repos().agentSessions.listByPlan(plan.id)).toEqual([]);
    });
  });

  describe('routine', () => {
    it('登録・更新・単発スキップ・削除（他の利用者のものは触れない）', async () => {
      await seedUsers();
      const created = await repos().routines.create({
        userId: U1,
        routineName: 'ジム',
        startTime: '19:00',
        endTime: '20:30',
      });
      expect(created).toMatchObject({
        startTime: '19:00:00',
        endTime: '20:30:00',
        skippedDate: null,
      });
      await repos().routines.create({ userId: U1, routineName: '散歩' });

      expect(await repos().routines.update(U2, created.id, { routineName: 'x' })).toBeUndefined();
      const skipped = await repos().routines.update(U1, created.id, { skippedDate: '2026-11-10' });
      expect(skipped?.skippedDate).toBe('2026-11-10');
      const resumed = await repos().routines.update(U1, created.id, { skippedDate: null });
      expect(resumed?.skippedDate).toBeNull();

      expect((await repos().routines.listByUser(U1)).map((r) => r.routineName)).toEqual([
        'ジム',
        '散歩',
      ]);
      expect(await repos().routines.findById(U2, created.id)).toBeUndefined();
      expect(await repos().routines.delete(U2, created.id)).toBe(false);
      expect(await repos().routines.delete(U1, created.id)).toBe(true);
      expect(await repos().routines.listByUser(U1)).toHaveLength(1);
    });

    it('開始が終了より後の時刻は DB が拒否する', async () => {
      await seedUsers();
      await client().query('savepoint before_invalid');
      await expect(
        repos().routines.create({
          userId: U1,
          routineName: 'x',
          startTime: '21:00',
          endTime: '20:00',
        }),
      ).rejects.toThrow();
      await client().query('rollback to savepoint before_invalid');
    });
  });

  describe('memo', () => {
    it('登録・チェック・一覧（新しい順）・削除', async () => {
      await seedUsers();
      const first = await repos().memos.create({ userId: U1, memoText: '牛乳\n卵' });
      const second = await repos().memos.create({ userId: U1, memoText: '電池' });
      await repos().memos.create({ userId: U2, memoText: '他の人のメモ' });
      expect(first.checkedLines).toEqual([]);

      const checked = await repos().memos.update(U1, first.id, { checkedLines: [1] });
      expect(checked?.checkedLines).toEqual([1]);
      expect(await repos().memos.update(U2, first.id, { memoText: 'x' })).toBeUndefined();
      expect((await repos().memos.listByUser(U1)).map((m) => m.id)).toEqual([second.id, first.id]);
      expect(await repos().memos.findById(U2, first.id)).toBeUndefined();
      expect(await repos().memos.delete(U1, second.id)).toBe(true);
      expect(await repos().memos.listByUser(U1)).toHaveLength(1);
    });

    it('deleteCreatedBefore は古いメモだけを消す（自動削除バッチ）', async () => {
      await seedUsers();
      const old = await repos().memos.create({ userId: U1, memoText: '古い' });
      const recent = await repos().memos.create({ userId: U2, memoText: '新しい' });
      await client().query(`update memo set created_at = now() - interval '8 days' where id = $1`, [
        old.id,
      ]);
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
      expect(await repos().memos.deleteCreatedBefore(weekAgo)).toBe(1);
      expect(await repos().memos.findById(U1, old.id)).toBeUndefined();
      expect(await repos().memos.findById(U2, recent.id)).toBeDefined();
    });
  });

  describe('calendar_integration・calendar_event', () => {
    const connect = () =>
      repos().calendarIntegrations.upsert({
        userId: U1,
        provider: 'google',
        secretName: `integration/${U1}/google`,
        scope: 'calendar.readonly',
      });
    const event = (calendarIntegrationId: number, externalEventId: string, start: string) => ({
      userId: U1,
      calendarIntegrationId,
      externalEventId,
      eventTitle: '定例',
      eventDate: '2026-11-10',
      startTime: at(`2026-11-10T${start}:00+09:00`),
      endTime: at(`2026-11-10T${start}:00+09:00`),
    });

    it('連携は利用者・プロバイダーごとに1件（連携し直すと上書き）', async () => {
      await seedUsers();
      const first = await connect();
      expect(first).toMatchObject({ status: 'connected', lastSyncedAt: null });
      await repos().calendarIntegrations.update(U1, 'google', {
        status: 'error',
        lastError: 'invalid_grant',
      });
      const again = await connect();
      expect(again.id).toBe(first.id);
      expect(again).toMatchObject({ status: 'connected', lastError: null });
      expect(await repos().calendarIntegrations.listByUser(U1)).toHaveLength(1);
      expect(await repos().calendarIntegrations.findByProvider(U1, 'outlook')).toBeUndefined();
      expect(await repos().calendarIntegrations.findByProvider(U2, 'google')).toBeUndefined();
    });

    it('予定は開始時刻順に取れ、同じ予定は更新になる', async () => {
      await seedUsers();
      const integration = await connect();
      await repos().calendarEvents.upsertMany([
        event(integration.id, 'e2', '15:00'),
        event(integration.id, 'e1', '10:00'),
      ]);
      await repos().calendarEvents.upsertMany([
        {
          ...event(integration.id, 'e1', '11:00'),
          eventTitle: '定例（時間変更）',
          location: '会議室A',
        },
      ]);
      const events = await repos().calendarEvents.listByUserAndDate(U1, '2026-11-10');
      expect(events.map((e) => [e.externalEventId, e.eventTitle, e.location])).toEqual([
        ['e1', '定例（時間変更）', '会議室A'],
        ['e2', '定例', null],
      ]);
      expect(await repos().calendarEvents.listByUserAndDate(U1, '2026-11-11')).toEqual([]);
      expect(await repos().calendarEvents.upsertMany([])).toEqual([]);
    });

    it('その日の分の削除・古い日付の削除・連携解除での削除', async () => {
      await seedUsers();
      const integration = await connect();
      await repos().calendarEvents.upsertMany([
        event(integration.id, 'e1', '10:00'),
        { ...event(integration.id, 'old', '10:00'), eventDate: '2026-11-09' },
      ]);
      expect(await repos().calendarEvents.deleteBefore('2026-11-10')).toBe(1);
      expect(
        await repos().calendarEvents.deleteByIntegrationAndDate(integration.id, '2026-11-10'),
      ).toBe(1);

      await repos().calendarEvents.upsertMany([event(integration.id, 'e1', '10:00')]);
      expect(await repos().calendarIntegrations.delete(U1, 'google')).toBe(true);
      expect(await repos().calendarEvents.listByUserAndDate(U1, '2026-11-10')).toEqual([]);
      expect(await repos().calendarIntegrations.delete(U1, 'google')).toBe(false);
    });
  });

  describe('departure_log・point_program・generation_quota', () => {
    it('出発検知記録を残せる', async () => {
      await seedUsers();
      const plan = await newPlan(U1);
      await repos().departureLogs.insert({
        userId: U1,
        planId: plan.id,
        plannedDepartureTime: at('2026-11-10T13:00:00+09:00'),
        actualDepartureTime: at('2026-11-10T13:04:00+09:00'),
        preparationTimeMinutes: 34,
      });
      expect(await repos().departureLogs.listByUser(U1)).toHaveLength(1);
      expect(await repos().departureLogs.listByUser(U2)).toEqual([]);
    });

    it('ポイントプログラムは有効・無効を上書き保存する（二重登録しない）', async () => {
      await seedUsers();
      await repos().pointPrograms.set(U1, 'ponta', true);
      await repos().pointPrograms.set(U1, 'dpoint', true);
      await repos().pointPrograms.set(U1, 'ponta', false);
      expect(
        (await repos().pointPrograms.listByUser(U1)).map((p) => [p.programCode, p.isEnabled]),
      ).toEqual([
        ['dpoint', true],
        ['ponta', false],
      ]);
      expect(await repos().pointPrograms.listByUser(U2)).toEqual([]);
    });

    it('生成回数は利用者・日付ごとに数え、古い日付は消せる', async () => {
      await seedUsers();
      const quota = repos().generationQuotas;
      expect(await quota.getUsedCount(U1, '2026-11-10')).toBe(0);
      expect(await quota.increment(U1, '2026-11-10')).toBe(1);
      expect(await quota.increment(U1, '2026-11-10')).toBe(2);
      expect(await quota.increment(U1, '2026-11-11')).toBe(1);
      expect(await quota.increment(U2, '2026-11-10')).toBe(1);
      expect(await quota.getUsedCount(U1, '2026-11-10')).toBe(2);
      expect(await quota.deleteBefore('2026-11-11')).toBe(2);
      expect(await quota.getUsedCount(U1, '2026-11-10')).toBe(0);
      expect(await quota.getUsedCount(U1, '2026-11-11')).toBe(1);
    });

    it('計画を消しても生成回数は戻らない', async () => {
      await seedUsers();
      const plan = await newPlan(U1);
      await repos().generationQuotas.increment(U1, '2026-11-10');
      await repos().plans.delete(U1, plan.id);
      expect(await repos().generationQuotas.getUsedCount(U1, '2026-11-10')).toBe(1);
    });
  });
});
