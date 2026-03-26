import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      exclude: ['dist/**', 'node_modules/**', '**/__tests__/**'],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
      },
    },
  },
});
