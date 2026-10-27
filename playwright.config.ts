// `npm run e2e` — the canvas, driven in a real browser (e2e/). `npm test` pins the FILE FORMAT; this pins
// the interactions: cards, frames, lines and ports, folding, menus. Each test gets a fresh browser
// context, so a fresh OPFS: a new, empty map. The dev server is started on its own port (and reused if
// one is already up there).
import { defineConfig, devices } from '@playwright/test';

const PORT = 5179;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 1200, height: 800 },
    locale: 'en-US',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 800 } } }],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
