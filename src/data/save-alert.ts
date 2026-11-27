// The save-failure banner: unlike the fading toast it stays up while any writer fails, retrying with backoff.
import { byId } from '../utils/dom.js';

type Source = 'notes' | 'board';
const failing = new Map<Source, { msg: string; retry: () => void; timer: number; attempt: number }>();
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000];   // the last repeats until a write lands

// A map saved by a newer build: nothing is written while it stands, and the banner offers a reload.
let held = '';

export function holdWrites(why: string): void {
  held = why;
  paint();
}

export function releaseWrites(): void {
  if (held) {
    held = '';
    paint();
  }
}

export function writesHeld(): boolean { return !!held; }

function paint(): void {
  const el = byId('saveAlert');
  document.body.classList.toggle('save-failing', failing.size > 0 || !!held);
  byId('saveAlertRetry').textContent = held ? 'Reload' : 'Retry now';
  if (held) {
    byId('saveAlertMsg').textContent = held;
    el.hidden = false;
    return;
  }
  if (!failing.size) { el.hidden = true; return; }
  const msg = [...new Set([...failing.values()].map(f => f.msg))].join(' · ');   // one disk, one error
  byId('saveAlertMsg').textContent = `Changes not saved. ${msg} Retrying…`;
  el.hidden = false;
}

// What to DO; the raw error goes to the console.
function howToFix(err: unknown): string {
  switch ((err as Error)?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Corkboard lost permission to write to the folder. Open the map again from Home.';
    case 'QuotaExceededError':
      return 'The disk or browser storage is full. Free some space.';
    case 'NotFoundError':
      return 'The map’s folder was moved or deleted. Put it back, or open it again from Home.';
    case 'NoModificationAllowedError':
    case 'InvalidStateError':
      return 'Another app is holding the file. Close it there.';
    default:
      return `${(err as Error)?.message || String(err)}.`;
  }
}

export function saveFailed(src: Source, err: unknown, retry: () => void): void {
  console.error(`Save failed (${src}):`, err);
  const prev = failing.get(src);
  if (prev) {
    clearTimeout(prev.timer);
  }
  const attempt = prev ? prev.attempt + 1 : 0;
  const msg = howToFix(err);
  const timer = window.setTimeout(retry, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
  failing.set(src, { msg, retry, timer, attempt });
  paint();
}
export function saveSucceeded(src: Source): void {
  const f = failing.get(src);
  if (!f) {
    return;
  }
  clearTimeout(f.timer);
  failing.delete(src);
  paint();
}

export function installSaveAlert(): void {
  byId('saveAlertRetry').addEventListener('click', () => {
    if (held) {
      location.reload();
      return;
    }
    for (const f of failing.values()) {
      clearTimeout(f.timer);
      f.retry();
    }
  });
}
