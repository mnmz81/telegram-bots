import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // test-only binding so the setup file can apply the migrations to the local D1
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, 'migrations')) },
      },
    })),
  ],
  test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] },
});
