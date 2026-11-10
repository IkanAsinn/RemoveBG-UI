/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/**
 * Send the isolation headers on every response. Vite's `server.headers` / `preview.headers` are dropped from
 * `304 Not Modified` replies, and WebKit then refuses a revalidated worker script under COEP (T-028: the full-model
 * worker failed to start in WebKit). Production hosting must likewise send both headers on all responses, 304s included.
 */
const isolationEverywhere = (): Plugin => {
  const use = (_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    for (const [k, v] of Object.entries(isolationHeaders)) res.setHeader(k, v)
    next()
  }
  return {
    name: 'isolation-headers-everywhere',
    configureServer: (server) => void server.middlewares.use(use),
    configurePreviewServer: (server) => void server.middlewares.use(use),
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), isolationEverywhere()],
  // onnxruntime-web locates its .wasm via import.meta.url; pre-bundling would break that in dev.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // Cross-origin isolation enables SharedArrayBuffer, which multi-threaded WASM inference requires.
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  // The inference worker lazily imports ORT, which needs code-splitting (ES module workers).
  worker: { format: 'es' },
  build: {
    // The lazily loaded WASM HEIC decoder chunk is ~2 MB; that payload is accepted by NFR-15.
    chunkSizeWarningLimit: 2500,
  },
  test: {
    environment: 'jsdom',
    // Browser end-to-end specs in e2e/ run under Playwright (`npm run e2e`), not Vitest.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
