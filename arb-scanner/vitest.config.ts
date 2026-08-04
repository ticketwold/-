import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@scanner': resolve(__dirname, 'src/scanner'),
      '@adapters': resolve(__dirname, 'src/scanner/adapters'),
    },
  },
});
