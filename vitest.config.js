import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/helpers/setup.js'],
    include: ['tests/**/*.test.js'],
    testTimeout: 20000,
  },
});
