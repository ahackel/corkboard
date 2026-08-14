// ---------- full-screen image viewer ----------
// Opened by the magnifier button shown over each image on a selected card (see main.ts nodeEl /
// utils/markdown.ts imgTag). Shows the already-resolved image (its blob/remote URL) centred on a
// dark backdrop; closes on the × button, Escape, or a click on the backdrop outside the image.
//
// It also PAGES: ‹ / › (and ←/→) step through every image in the cards that share the opened card's
// parent — the set you'd think of as "these ones", a frame's contents or a branch's siblings. Built
// from the NOTES rather than the rendered DOM, so a folded sibling's images are in the run too, and
// wrapping at both ends, since a handful of pictures read as a loop rather than a strip with ends.
import { state } from '../core/state.js';
import { selectNode } from '../main.js';
import { imageUrl } from './images.js';

let overlay: HTMLElement | null = null;
let imgEl: HTMLImageElement | null = null;

// One picture in the run: which note holds it, its vault path (or remote URL) and its alt text.
interface Shot { nodeId: string; path: string; alt: string }
let run: Shot[] = [];
let at = -1;
let token = 0;      // guards the async resolve below: only the newest step may paint

const IMG_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
// Every image in every note that shares `nodeId`'s parent, the card itself included, in the order
// they read on the canvas: top-to-bottom, then left-to-right, then the order they appear in each
// note. Deliberately off `body` and not off the DOM — a folded card renders only its first line, and
// its pictures are no less part of the set for that.
function siblingRun(nodeId: string): Shot[] {
  const n = state.nodes.get(nodeId);
  if (!n) return [];
  const sibs = [...state.nodes.values()].filter(m => m.parent === n.parent);
  sibs.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const out: Shot[] = [];
  for (const s of sibs) {
    IMG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMG_RE.exec(s.body || ''))) out.push({ nodeId: s.id, path: m[2], alt: m[1].trim() });
  }
  return out;
}
function build(): void {
  overlay = document.createElement('div');
  overlay.id = 'imgViewer';
  overlay.innerHTML = `<button type="button" class="iv-close" aria-label="Close">&times;</button>`
    + `<button type="button" class="iv-nav iv-prev" aria-label="Previous image">&lsaquo;</button>`
    + `<img class="iv-img" alt="">`
    + `<button type="button" class="iv-nav iv-next" aria-label="Next image">&rsaquo;</button>`;
  imgEl = overlay.querySelector('.iv-img');
  overlay.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.iv-prev')) { step(-1); return; }
    if (t.closest('.iv-next')) { step(1); return; }
    // click on the backdrop (not the image itself) closes
    if (t === overlay || t.classList.contains('iv-close')) closeImageViewer();
  });
  document.body.appendChild(overlay);
}
// Escape closes; the arrows page; SPACE closes too (it's what opened the viewer — main.ts's Space tap).
// Registered in CAPTURE, and everything handled is stopped, so the canvas underneath never sees these
// keys: ←/→ mean fold/unfold there (navArrow), Escape would clear the selection on top of closing, and
// Space would fall through to the hand-pan/new-card gesture.
// Space is split across the two events on purpose: the KEYDOWN is swallowed (so main.ts can't latch
// `spaceHeld` and leave the canvas in hand-pan mode) and the KEYUP does the closing — which also keeps
// main.ts's own Space keyup, the one that would re-open the viewer on the still-selected card, from
// ever running.
function onKey(e: KeyboardEvent): void {
  if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImageViewer(); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault(); e.stopPropagation();
  step(e.key === 'ArrowLeft' ? -1 : 1);
}
function onKeyUp(e: KeyboardEvent): void {
  if (e.key !== ' ') return;
  e.preventDefault(); e.stopPropagation();
  closeImageViewer();
}
// Show run[at]. The URL comes from the same per-path cache the cards' own images resolve through
// (features/images.ts), so paging back and forth reads each file once.
function show(): void {
  const shot = run[at];
  if (!shot || !imgEl) return;
  const mine = ++token;
  void imageUrl(shot.path).then(url => {
    if (mine !== token || !imgEl || !url) return;   // stepped again while this one was loading
    imgEl.src = url; imgEl.alt = shot.alt;
  });
}
function step(d: number): void {
  if (run.length < 2) return;
  at = (at + d + run.length) % run.length;          // wrap: a set of pictures is a loop, not a strip
  show();
}
// `from` is the image that was clicked — its card and its path, which is what the run is built
// around. Without it (a caller that only has a URL) the viewer still opens, just without paging.
export function openImageViewer(src: string, alt = '', from?: { nodeId: string; path: string }): void {
  if (!src) return;
  if (!overlay) build();
  imgEl!.src = src; imgEl!.alt = alt;
  run = from ? siblingRun(from.nodeId) : [];
  at = from ? run.findIndex(s => s.nodeId === from.nodeId && s.path === from.path) : -1;
  if (at < 0) run = [];                              // couldn't place it → no run to page through
  // One picture is not a sequence; hiding the arrows keeps that honest rather than offering two
  // buttons that do nothing.
  overlay!.classList.toggle('iv-paged', run.length > 1);
  overlay!.classList.add('open');
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
}
export function closeImageViewer(): void {
  if (!overlay) return;
  overlay.classList.remove('open');
  if (imgEl) imgEl.removeAttribute('src');
  // You come back out onto the card you were LOOKING at, not the one you came in from: page three
  // pictures along and close, and the selection is that third card — so the next thing you do (move it,
  // colour it, delete it) lands where your eyes already were. Selection only; the camera stays put.
  const last = run[at];
  run = []; at = -1; token++;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKeyUp, true);
  if (last && state.nodes.has(last.nodeId)) selectNode(last.nodeId);
}
