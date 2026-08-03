import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@scanner': resolve(__dirname, 'src/scanner'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
