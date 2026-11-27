// Full-screen image viewer; ‹ / › and ←/→ page, wrapping, through the images of the opened card's siblings.
import { state } from '../core/state.js';
import { imageUrl } from '../data/images.js';
import { childrenOf } from '../utils/model.js';
import { bodyImages } from '../utils/markdown.js';
import { selectNode } from './selection.js';

let overlay: HTMLElement | null = null;
let imgEl: HTMLImageElement | null = null;

// `path` is a vault path or a remote URL.
interface Shot { nodeId: string; path: string; alt: string }
let run: Shot[] = [];
let at = -1;
let latestShow = 0;

// In reading order. Built from the notes, not the DOM, so a folded card's pictures count too.
function siblingRun(nodeId: string): Shot[] {
  const n = state.nodes.get(nodeId);
  if (!n) {
    return [];
  }
  const sibs = childrenOf(n.parent);
  sibs.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const out: Shot[] = [];
  for (const s of sibs) {
    for (const { src, alt } of bodyImages(s.body)) {
      out.push({ nodeId: s.id, path: src, alt });
    }
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
    if (t === overlay || t.classList.contains('iv-close')) {
      closeImageViewer();
    }
  });
  document.body.appendChild(overlay);
}

// Capture phase, and stopped, so the canvas never sees these keys (←/→ fold there, Space pans).
// Space closes on KEYUP: swallowing its keydown stops commands.ts latching hand-pan, and closing
// on keyup pre-empts commands.ts's Space keyup re-opening the viewer.
function onKey(e: KeyboardEvent): void {
  if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImageViewer(); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
    return;
  }
  e.preventDefault(); e.stopPropagation();
  step(e.key === 'ArrowLeft' ? -1 : 1);
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key !== ' ') {
    return;
  }
  e.preventDefault(); e.stopPropagation();
  closeImageViewer();
}

function show(): void {
  const shot = run[at];
  if (!shot || !imgEl) {
    return;
  }
  const mine = ++latestShow;
  void imageUrl(shot.path, state.nodes.get(shot.nodeId)?.file).then(url => {
    if (mine !== latestShow || !imgEl || !url) {
      return;
    }
    imgEl.src = url; imgEl.alt = shot.alt;
  });
}

function step(d: number): void {
  if (run.length < 2) {
    return;
  }
  at = (at + d + run.length) % run.length;
  show();
}

// Without `from` (the clicked image's card and path) the viewer opens without paging.
export function openImageViewer(src: string, alt = '', from?: { nodeId: string; path: string }): void {
  if (!src) {
    return;
  }
  if (!overlay) {
    build();
  }
  imgEl!.src = src; imgEl!.alt = alt;
  run = from ? siblingRun(from.nodeId) : [];
  at = from ? run.findIndex(s => s.nodeId === from.nodeId && s.path === from.path) : -1;
  if (at < 0) {
    run = [];
  }
  overlay!.classList.toggle('iv-paged', run.length > 1);
  overlay!.classList.add('open');
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
}

function closeImageViewer(): void {
  if (!overlay) {
    return;
  }
  overlay.classList.remove('open');
  if (imgEl) {
    imgEl.removeAttribute('src');
  }
  // Select the card you were last LOOKING at, not the one you came in from.
  const last = run[at];
  run = []; at = -1; latestShow++;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKeyUp, true);
  if (last && state.nodes.has(last.nodeId)) {
    selectNode(last.nodeId);
  }
}
