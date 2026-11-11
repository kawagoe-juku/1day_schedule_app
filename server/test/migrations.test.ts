import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
});
