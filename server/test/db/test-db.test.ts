import { describe, expect, it } from 'vitest';
import { user } from '../../src/db/schema.js';
import { useTestDb } from '../helpers/test-db.js';

describe('テスト用 DB の仕組み', () => {
  const { db, client } = useTestDb();

  it('マイグレーション済みで、12テーブルがある', async () => {
    const res = await client().query<{ count: string }>(
      `select count(*) from information_schema.tables where table_schema = 'public'`,
    );
    expect(Number(res.rows[0]?.count)).toBe(12);
  });

  it('Drizzle で登録・取得でき、既定値が入る', async () => {
    await db().insert(user).values({ id: 'sub-test-1' });
    const rows = await db().select().from(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'sub-test-1',
      walkingSpeed: 'normal',
      preparationTimeMinutes: 30,
      priorityCondition: 'on_time',
      frequentlyUsedStations: [],
      onboardingCompleted: false,
    });
  });

  it('前のテストで登録したデータは残っていない（テストごとに巻き戻す）', async () => {
    expect(await db().select().from(user)).toHaveLength(0);
  });
});
