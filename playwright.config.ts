// `npm run e2e` — the canvas, driven in a real browser (e2e/). `npm test` pins the FILE FORMAT; this pins
// the interactions: cards, frames, lines and ports, folding, menus. Each test gets a fresh browser
// context, so a fresh OPFS: a new, empty map. The specs run against the BUILT single file (what ships),
// served on its own port: a 2s build, then every page load is one request instead of the dev server's
// per-module transforms, which cost the suite about a third of its CPU.
import { defineConfig, devices } from '@playwright/test';

const PORT = 5179;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: true,
  workers: '100%',   // every core: the default (half) left this machine idle while specs waited
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1200, height: 800 },
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 800 } } }],
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,   // a leftover server would serve a stale build
    timeout: 60_000,
  },
});
