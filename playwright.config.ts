import { defineConfig } from '@playwright/test'

/**
 * @description Playwright configuration for the E2E suite in `e2e/`.
 * - One worker: the specs share a dev server whose disk/L1 caches and
 *   camera-independent state make parallel runs interfere.
 * - `webServer` boots `npm run dev` when no server is listening, and
 *   reuses yours when one is (reuseExistingServer) — so a dev session
 *   and the test run don't fight over port 3000.
 * - SwiftShader flag: headless Chromium has no GPU; the star field is
 *   WebGL and needs the software rasterizer.
 * - Generous per-test timeout: first page load includes catalog fetches
 *   (disk-cached after the first run) plus WebGL boot.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    viewport: { width: 1600, height: 900 },
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
