import { defineConfig } from 'vitest/config';

// Starting an in-memory PostgreSQL takes a few seconds, and several test files start one at the same time,
// so setup is allowed more time than Vitest's 10-second default.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
