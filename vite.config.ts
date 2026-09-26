import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

/**
 * Cross-origin isolation headers.
 *
 * These are required for `SharedArrayBuffer`, which the multithreaded FFmpeg core
 * (`@ffmpeg/core-mt`) needs. Only Tier C depends on them — the Mediabunny/WebCodecs
 * and image tiers work without cross-origin isolation. See docs/DECISIONS.md.
 *
 * Production must send the same headers; see deploy/nginx.conf.sample.
 */
export const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      // Precache the app shell ONLY. The WASM engines are 30MB+; precaching them
      // would turn "install the app" into a 30MB download, so they are fetched
      // lazily and cached on first use instead. See docs/DECISIONS.md.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/engines/**', '**/*.wasm'],
        runtimeCaching: [
          {
            // Content-hashed engine assets => safe to cache forever.
            urlPattern: /\/engines\/.*\.(wasm|js)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wff-engines-v1',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Web Format Factory',
        short_name: 'Format Factory',
        description:
          'Convert images, video, audio and Live Photos entirely in your browser. No uploads.',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        start_url: '/',
      },
    }),
  ],
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    // Code splitting is driven by dynamic `import()` at the engine boundaries —
    // each engine (and each wasm kernel) is fetched only when a job actually needs it.
    // See docs/ARCHITECTURE.md.
  },
});
