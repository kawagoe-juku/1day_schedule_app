import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('未指定の項目は既定値になる', () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.NODE_ENV).toBe('development');
    expect(c.DATABASE_URL).toBeUndefined();
  });

  it('PORTは数値に変換される', () => {
    expect(loadConfig({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('不正な値は起動時にエラーになる', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('環境変数が不正です');
  });
});
