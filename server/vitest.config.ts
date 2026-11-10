import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // DB を使うテストは npm run test:db（vitest.db.config.ts）で動かす
    exclude: ['test/db/**'],
  },
});
