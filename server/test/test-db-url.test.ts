import { describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './helpers/test-db.js';

describe('testDatabaseUrl', () => {
  it('未指定ならローカルの schedule_app_test', () => {
    expect(testDatabaseUrl({})).toBe('postgres://app:app@localhost:5432/schedule_app_test');
  });

  it('_test で終わる DB は使える', () => {
    const url = 'postgres://u:p@db.example.internal:5432/app_test';
    expect(testDatabaseUrl({ TEST_DATABASE_URL: url })).toBe(url);
  });

  // 開発用・本番用の DB をテストで書き換えない
  it.each(['schedule_app', 'test_app', 'app_test2', ''])('DB 名が %j なら拒否する', (name) => {
    const url = `postgres://u:p@localhost:5432/${name}`;
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: url })).toThrow('_test');
  });
});
