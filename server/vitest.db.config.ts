import { defineConfig } from 'vitest/config';

// DB を使うテスト（npm run test:db）。ローカルの PostgreSQL が必要なので、npm test とは分けている
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/db/**/*.test.ts'],
    globalSetup: ['test/helpers/test-db-setup.ts'],
    // 同じ DB を使うので、ファイルを並行に走らせない
    fileParallelism: false,
  },
});
