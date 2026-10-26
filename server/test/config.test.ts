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

  it('DB_HOST などの項目から DATABASE_URL を組み立てる（パスワードは URL エンコード）', () => {
    const c = loadConfig({
      DB_HOST: 'db.example.internal',
      DB_NAME: 'schedule_app',
      DB_USER: 'app_admin',
      DB_PASSWORD: 'p@ss/word',
    });
    expect(c.DATABASE_URL).toBe(
      'postgres://app_admin:p%40ss%2Fword@db.example.internal:5432/schedule_app',
    );
  });

  it('DB_HOST だけで他の項目がないとエラーになる', () => {
    expect(() => loadConfig({ DB_HOST: 'db.example.internal' })).toThrow('DB_NAME');
  });

  it('本番では DB の接続設定・JWT の検証先・TLS の CA が必須', () => {
    const prod = { NODE_ENV: 'production' };
    expect(() => loadConfig(prod)).toThrow('DB_HOST または DATABASE_URL');
    const db = { DATABASE_URL: 'postgres://u:p@db.example.internal:5432/app' };
    expect(() => loadConfig({ ...prod, ...db })).toThrow('COGNITO_USER_POOL_ID');
    const cognito = { COGNITO_USER_POOL_ID: 'ap-northeast-1_x', COGNITO_WEB_CLIENT_ID: 'c' };
    expect(() => loadConfig({ ...prod, ...db, ...cognito })).toThrow('DB_SSL_CA_PATH');
    const ca = { DB_SSL_CA_PATH: '/app/certs/ca.pem' };
    expect(loadConfig({ ...prod, ...db, ...cognito, ...ca }).NODE_ENV).toBe('production');
  });

  it('不正な値は起動時にエラーになる', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('環境変数が不正です');
  });
});
