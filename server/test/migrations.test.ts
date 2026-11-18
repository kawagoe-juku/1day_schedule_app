import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findUnapplied } from '../src/db/migration-client.js';

const folder = fileURLToPath(new URL('../drizzle', import.meta.url));
const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as {
  entries: { tag: string }[];
};

describe('マイグレーション', () => {
  it('1件以上ある', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  // 取り消し用の SQL を書き忘れると、db:rollback ができなくなる
  it.each(journal.entries.map((e) => e.tag))('%s に適用と取り消しの SQL がある', (tag) => {
    expect(existsSync(`${folder}/${tag}.sql`)).toBe(true);
    expect(existsSync(`${folder}/down/${tag}.sql`)).toBe(true);
  });

  describe('適用漏れの検出（findUnapplied）', () => {
    const journal = [
      { when: 100, tag: '0000_init' },
      { when: 200, tag: '0001_a' },
      { when: 300, tag: '0002_b' },
    ];

    it('すべて適用済みなら空（DB の値は文字列で返る）', () => {
      expect(findUnapplied(journal, ['100', '200', '300'])).toEqual([]);
    });

    it('日時の新しいものが先に適用されて飛ばされたものを返す', () => {
      expect(findUnapplied(journal, ['100', '300'])).toEqual(['0001_a']);
    });

    it('DB のほうが進んでいても（前の版に戻したとき）問題にしない', () => {
      expect(findUnapplied(journal, ['100', '200', '300', '400'])).toEqual([]);
    });
  });
});
