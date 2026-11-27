// Asks `version.json` (written by the build) whether a newer deploy is out, and offers the Update button.
// See "A window left open is told when a newer version is out" in docs/architecture.md.
import { byId } from '../utils/dom.js';
import { settleSave } from '../data/save.js';

const EVERY_MS = 30 * 60 * 1000;
const AT_MOST_MS = 5 * 60 * 1000;

const button = byId<HTMLButtonElement>('updateBtn');
let lastAsked = 0;

async function check(): Promise<void> {
  if (!button.hidden || Date.now() - lastAsked < AT_MOST_MS) {
    return;
  }
  lastAsked = Date.now();
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    const latest = res.ok ? ((await res.json()) as { version?: unknown }).version : undefined;
    button.hidden = typeof latest !== 'string' || latest === __APP_VERSION__;
  } catch {
    // offline, or not deployed
  }
}

export function installUpdateCheck(): void {
  // A local build (`-dev`) has no deploy to compare with.
  if (import.meta.env.PROD && !__APP_VERSION__.endsWith('-dev')) {
    void check();
    window.setInterval(() => { void check(); }, EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    });
    window.addEventListener('focus', () => { void check(); });
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    await settleSave();
    location.reload();
  });
}
