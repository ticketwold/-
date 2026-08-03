import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = resolve(__dirname);
const dist = resolve(root, 'dist');

const contentEntries = {
  bti_content: resolve(root, 'src/content/bti/content.ts'),
  bti_api_hook: resolve(root, 'src/content/bti/api-hook.ts'),
  polymarket_content: resolve(root, 'src/content/bc/content.ts'),
  bc_slip_read: resolve(root, 'src/content/bc/slip-read.ts'),
  bc_api_hook: resolve(root, 'src/content/bc/api-hook.ts'),
  bc_sports_scrape: resolve(root, 'src/content/bc/sports-scrape.ts'),
  bc_betby_bridge: resolve(root, 'src/content/bc/betby-bridge.ts'),
  polymarket_bet_main: resolve(root, 'src/content/bc/bet-main.ts'),
  stake_slip_read: resolve(root, 'src/content/stake/slip-read.ts'),
  stake_content: resolve(root, 'src/content/stake/content.ts'),
  stake_api_hook: resolve(root, 'src/content/stake/api-hook.ts'),
  arb_bridge: resolve(root, 'src/content/arb/bridge.ts'),
};

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'extension-manifest',
      closeBundle() {
        mkdirSync(dist, { recursive: true });
        const manifestSrc = readFileSync(resolve(root, 'public/manifest.json'), 'utf8');
        writeFileSync(resolve(dist, 'manifest.json'), manifestSrc);
        const nestedPanel = resolve(dist, 'src/panel/index.html');
        const panelOut = resolve(dist, 'panel.html');
        try {
          let html = readFileSync(nestedPanel, 'utf8');
          html = html.replace(/\.\.\/\.\.\//g, './');
          writeFileSync(panelOut, html);
        } catch {
          /* already at dist root */
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@engine': resolve(root, 'src/engine'),
      '@panel': resolve(root, 'src/panel'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        service_worker: resolve(root, 'src/background/service_worker.ts'),
        panel: resolve(root, 'src/panel/index.html'),
        ...contentEntries,
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'service_worker') return 'service_worker.js';
          if (chunk.name === 'panel') return 'assets/panel.js';
          return `${chunk.name}.js`;
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (asset) => {
          if (asset.name === 'index.html' || asset.name === 'panel.html') return 'panel.html';
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
