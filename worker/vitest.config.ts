import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // @cloudflare/vitest-pool-workers 0.23 (deprecated, renamed to
        // @cloudflare/vitest-plugin) bundles an older workerd that only supports
        // compatibility dates up to 2026-08-22, so pin it for tests only.
        compatibilityDate: '2026-08-22',
        // Override wrangler vars/secrets for tests: mock LLM, known secret.
        bindings: {
          APP_SHARED_SECRET: 'test-secret',
          ADMIN_SECRET: 'test-admin',
          LLM_MODE: 'mock',
          DEV_MODE: 'true',
          ANTHROPIC_API_KEY: '',
        },
      },
    }),
  ],
  test: {
    testTimeout: 20_000,
    // Ensures ../admin/dist exists (placeholder admin/index.html if the UI isn't built).
    globalSetup: ['./test/global-setup.ts'],
  },
});
