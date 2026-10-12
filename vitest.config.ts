import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.{ts,tsx}', 'mobile/test/**/*.test.ts'],
    testTimeout: 60000,
    // Server modules read these at import: keep test data out of ./data and don't start jobs.
    env: { DATA_DIR: './node_modules/.tmp/test-data', RUN_JOBS: 'false', NODE_ENV: 'test' },
    hookTimeout: 120000,
  },
});
