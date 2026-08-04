import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = resolve(__dirname);

function fixExtensionHtml(html: string, page: string): string {
  return html
    .replace(/\.\.\/\.\.\//g, './')
    .replace(`./${page}.ts`, `./assets/${page}.js`)
    .replace(`./${page}.css`, `./assets/${page}.css`)
    .replace(/src="\/assets\//g, 'src="./assets/')
    .replace(/href="\/assets\//g, 'href="./assets/')
    .replace(/href="\/chunks\//g, 'href="./chunks/');
}

export default defineConfig({
  base: './',
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
        panel: resolve(root, 'src/panel/panel.html'),
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

        for (const page of ['popup', 'panel', 'options'] as const) {
          const nested = resolve(dist, `src/${page}/${page}.html`);
          const flat = resolve(dist, `${page}.html`);
          try {
            let html = readFileSync(nested, 'utf8');
            html = fixExtensionHtml(html, page);
            writeFileSync(flat, html);
          } catch {
            /* vite may emit at root */
          }
          try {
            const rootHtml = resolve(dist, `${page}.html`);
            let html = readFileSync(rootHtml, 'utf8');
            html = fixExtensionHtml(html, page);
            writeFileSync(rootHtml, html);
          } catch {
            /* ignore */
          }
        }
      },
    },
  ],
});
