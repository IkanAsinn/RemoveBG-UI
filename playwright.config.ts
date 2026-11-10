import { defineConfig, devices } from '@playwright/test'

// End-to-end checks (T-027…T-030). Run against the production build served by `vite preview`, which sends the same
// cross-origin isolation headers as production.
// - Project "chrome" runs every spec in the installed Google Chrome (no browser download needed).
// - The browser matrix (T-028, e2e/matrix.spec.ts) also runs in Edge, Playwright's Firefox and WebKit builds, and
//   mobile emulation. Install the engines once with `npx playwright install firefox webkit`.
// Set E2E_CHANNEL=chromium (after `npx playwright install chromium`) to use Playwright's Chromium for "chrome".
const PORT = 4173
const matrixOnly = /matrix\.spec\.ts/

export default defineConfig({
  testDir: 'e2e',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'node_modules/.e2e-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: process.env.E2E_CHANNEL ?? 'chrome', viewport: { width: 1280, height: 860 } } },
    { name: 'edge', testMatch: matrixOnly, use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'firefox', testMatch: matrixOnly, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testMatch: matrixOnly, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', testMatch: matrixOnly, use: { ...devices['Pixel 7'], channel: 'chrome' } },
    { name: 'mobile-webkit', testMatch: matrixOnly, use: { ...devices['iPhone 15'] } },
  ],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
})
