import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'sim/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Tests touch real temp directories and child git processes; one file at a time keeps them honest.
    fileParallelism: false,
  },
});
