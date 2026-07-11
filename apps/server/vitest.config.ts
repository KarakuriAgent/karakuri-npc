import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    restoreMocks: true,
    include: ['test/**/*.test.ts'],
  },
});
