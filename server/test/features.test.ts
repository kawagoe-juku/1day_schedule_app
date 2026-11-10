import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  assertFeatureEnabled,
  FEATURES,
  isFeatureEnabled,
  type FeatureName,
} from '../src/features.js';

const names = Object.keys(FEATURES) as FeatureName[];

describe('Feature Flag', () => {
  it('対象は6つ（音声入力・通知・延期再計画・出発検知・運行監視・段階通知）', () => {
    expect(names).toEqual([
      'voiceInput',
      'notification',
      'postponeReplan',
      'departureDetection',
      'operationMonitoring',
      'stagedNotification',
    ]);
  });

  it.each(names)('%s は既定で OFF', (name) => {
    expect(isFeatureEnabled(loadConfig({}), name)).toBe(false);
  });

  it.each(names)('%s は環境変数を true にするだけで ON になり、他は OFF のまま', (name) => {
    const config = loadConfig({ [FEATURES[name]]: 'true' });
    expect(isFeatureEnabled(config, name)).toBe(true);
    for (const other of names.filter((n) => n !== name)) {
      expect(isFeatureEnabled(config, other)).toBe(false);
    }
  });

  it('false を明示すると OFF', () => {
    expect(isFeatureEnabled(loadConfig({ FEATURE_VOICE_INPUT: 'false' }), 'voiceInput')).toBe(
      false,
    );
  });

  it.each(['1', 'on', 'TRUE', ''])('true/false 以外（%j）は起動時にエラーになる', (value) => {
    expect(() => loadConfig({ FEATURE_VOICE_INPUT: value })).toThrow('FEATURE_VOICE_INPUT');
  });
});

describe('assertFeatureEnabled', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Flag を確かめるだけのルートを足して、API としての応答を確かめる */
  const appWith = async (env: NodeJS.ProcessEnv) => {
    const config = loadConfig({ NODE_ENV: 'test', ...env });
    app = await buildApp({
      config,
      logger: false,
      verifier: { verify: async () => ({ sub: 'user-1', exp: 0 }) },
    });
    app.post('/api/speech/transcribe', async () => {
      assertFeatureEnabled(config, 'voiceInput');
      return { ok: true };
    });
    return app;
  };
  const call = (target: FastifyInstance) =>
    target.inject({
      method: 'POST',
      url: '/api/speech/transcribe',
      headers: { authorization: 'Bearer token' },
    });

  it('OFF のときは 501 FEATURE_DISABLED を共通エラー形式で返す', async () => {
    const res = await call(await appWith({}));
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatchObject({ code: 'FEATURE_DISABLED' });
    expect(res.json().error.requestId).toBeTruthy();
  });

  it('ON のときは処理に進む', async () => {
    const res = await call(await appWith({ FEATURE_VOICE_INPUT: 'true' }));
    expect(res.statusCode).toBe(200);
  });
});
