/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    PROFILE: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
