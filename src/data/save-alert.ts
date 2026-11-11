// ============================================================
// A failed save must be SEEN, and must STAY seen: the #status toast fades after two seconds — and an
// unsaved edit the user doesn't know about is the worst failure this
// app has. Each writer (the notes, board.json) reports here by name; the banner stays up while ANY
// of them is failing, retries on its own with a growing delay, and offers "Retry now".
// ============================================================
import { byId } from '../utils/dom.js';

type Source = 'notes' | 'board';
const failing = new Map<Source, { msg: string; retry: () => void; timer: number; attempt: number }>();
const DELAYS = [2000, 5000, 15000, 30000];   // then every 30s until a write lands

// A map this build must not write to at all (data/board.ts: it was saved by a newer one). Nothing is
// queued and nothing retried while it stands; the banner says so and offers the one way out.
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
  document.body.classList.toggle('save-failing', failing.size > 0 || !!held);   // the toast stands down (styles.css)
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

// The banner says what to DO; the raw error stays in the console (saveFailed logs it).
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
  const timer = window.setTimeout(retry, DELAYS[Math.min(attempt, DELAYS.length - 1)]);
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

byId('saveAlertRetry').addEventListener('click', () => {
  if (held) {
    location.reload();
    return;
  }
  for (const f of failing.values()) { clearTimeout(f.timer); f.retry(); }
});
