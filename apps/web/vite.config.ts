import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  cloudflareHeaders,
  readReleaseConfiguration,
  previewHeaders,
} from './scripts/lib/release-config.mjs';

export default defineConfig(({ mode }) => {
  const env = {
    ...loadEnv(mode, process.cwd(), 'VITE_'),
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_'))),
  };
  const configuration = readReleaseConfiguration(
    env,
    env['VITE_YELAXIS_RELEASE_TARGET'] ?? 'local',
  );
  return {
    resolve: {
      alias: [
        {
          find: /^zod$/u,
          replacement: fileURLToPath(new URL('./src/release/schema-runtime.ts', import.meta.url)),
        },
      ],
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('@js-temporal/polyfill')) return 'temporal';
            if (id.includes('react-dom') || id.includes('react-router') || id.includes('/react/')) {
              return 'react-runtime';
            }
            // Workspace layers get their own chunks so no single chunk crosses the 500 kB warning.
            if (id.includes('/packages/domain/') || id.includes('/packages/application/')) {
              return 'planning-core';
            }
            if (id.includes('/packages/data/')) return 'planning-data';
            // Reviews: the Review pages are their own chunk, still precached for offline use.
            if (id.includes('/apps/web/src/review/')) return 'review-ui';
            return undefined;
          },
        },
      },
    },
    optimizeDeps: {
      exclude: ['wa-sqlite'],
    },
    plugins: [
      react(),
      {
        name: 'yelaxis-reviewed-release-headers',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: '_headers',
            source: cloudflareHeaders(configuration),
          });
        },
        configurePreviewServer(server) {
          const source = readFileSync(new URL('./dist/_headers', import.meta.url), 'utf8');
          previewHeaders(source);
          server.middlewares.use((request, response, next) => {
            for (const [name, value] of Object.entries(
              previewHeaders(source, request.url ?? '/'),
            )) {
              response.setHeader(name, value);
            }
            next();
          });
        },
      },
      VitePWA({
        injectRegister: false,
        registerType: 'prompt',
        // The SVG favicon and the Axis icons are static shell assets; precache them so offline
        // reloads are complete.
        includeAssets: ['icons/yelaxis.svg', 'icons/axis/*.png'],
        manifest: {
          name: 'YelAxis Planner',
          short_name: 'YelAxis',
          description: 'Calm, local-first planning for every horizon.',
          theme_color: '#06111c',
          background_color: '#06111c',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/icons/yelaxis-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icons/yelaxis-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icons/yelaxis-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: false,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/test\//u],
          runtimeCaching: [],
          skipWaiting: false,
        },
      }),
    ],
    server: {
      host: '127.0.0.1',
    },
    preview: {
      host: '127.0.0.1',
    },
  };
});
