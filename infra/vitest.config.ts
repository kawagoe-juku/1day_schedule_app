import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// cdk.json の推奨設定（feature flags）をテストにも適用し、デプロイと同じテンプレートで確かめる
const { context } = JSON.parse(readFileSync(new URL('./cdk.json', import.meta.url), 'utf8')) as {
  context: Record<string, unknown>;
};

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // パイプライン（全スタックを含む）の synth は初回に数秒かかる
    testTimeout: 30_000,
    env: { CDK_CONTEXT_JSON: JSON.stringify(context) },
  },
});
