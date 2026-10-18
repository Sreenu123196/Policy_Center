import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Starting an in-memory PostgreSQL takes a few seconds, and several test files start one at the same time,
// so setup is allowed more time than Vitest's 10-second default.
// The screens' tests (web/src/*.test.tsx) run in a simulated browser (jsdom); each says so on its first line.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
