import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@scanner': resolve(root, 'src/scanner'),
      '@adapters': resolve(root, 'src/scanner/adapters'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        service_worker: resolve(root, 'src/background/service-worker.ts'),
        content: resolve(root, 'src/content/bootstrap.ts'),
        popup: resolve(root, 'src/popup/popup.html'),
        options: resolve(root, 'src/options/options.html'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'service_worker' || chunk.name === 'content') return '[name].js';
          return 'assets/[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  plugins: [
    {
      name: 'extension-bundle',
      closeBundle() {
        const dist = resolve(root, 'dist');
        mkdirSync(dist, { recursive: true });
        copyFileSync(resolve(root, 'public/manifest.json'), resolve(dist, 'manifest.json'));

        for (const page of ['popup', 'options'] as const) {
          const nested = resolve(dist, `src/${page}/${page}.html`);
          const flat = resolve(dist, `${page}.html`);
          try {
            let html = readFileSync(nested, 'utf8');
            html = html.replace(/\.\.\/\.\.\//g, './').replace(`./${page}.ts`, `./assets/${page}.js`);
            html = html.replace(`./${page}.css`, `./assets/${page}.css`);
            writeFileSync(flat, html);
          } catch {
            /* vite may emit at root */
          }
        }
      },
    },
  ],
});
