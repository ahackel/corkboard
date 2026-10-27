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

function paint(): void {
  const el = byId('saveAlert');
  if (!failing.size) { el.hidden = true; return; }
  const msg = [...new Set([...failing.values()].map(f => f.msg))].join(' · ');   // one disk, one error
  byId('saveAlertMsg').textContent = `Changes not saved — ${msg}. Retrying…`;
  el.hidden = false;
}
export function saveFailed(src: Source, err: unknown, retry: () => void): void {
  console.error(`Save failed (${src}):`, err);
  const prev = failing.get(src);
  if (prev) clearTimeout(prev.timer);
  const attempt = prev ? prev.attempt + 1 : 0;
  const msg = (err as Error)?.message || (err as Error)?.name || String(err);
  const timer = window.setTimeout(retry, DELAYS[Math.min(attempt, DELAYS.length - 1)]);
  failing.set(src, { msg, retry, timer, attempt });
  paint();
}
export function saveSucceeded(src: Source): void {
  const f = failing.get(src);
  if (!f) return;
  clearTimeout(f.timer);
  failing.delete(src);
  paint();
}

byId('saveAlertRetry').addEventListener('click', () => {
  for (const f of failing.values()) { clearTimeout(f.timer); f.retry(); }
});
