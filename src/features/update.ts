// A window can stay open for days — the installed app most of all — and a page only picks up a new deploy
// when it loads. So the window asks `version.json` (written by the build, vite.config.js) whether a newer
// version is out: when it regains focus, and every half hour while open, never more than every few minutes.
// A different version shows the Update button; its click saves what is pending, then reloads, and the
// service worker (public/sw.js) asks the network first, so the reload is the new version.
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
    // offline, or not deployed: nothing to say
  }
}

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
