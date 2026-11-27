// ---------- images in a card's DOM ----------
// The cache that resolves a picture to a URL is data/images.ts; this half puts those URLs into the cards,
// and reflows once when a card grows because a picture finally loaded.
import { relayout } from '../main.js';
import { imageUrl, knownImageUrl } from '../data/images.js';

// A card's body images are `pointer-events:none` (a click or drag over one falls through to the card
// itself), so no event ever has an <img> as its target — anything that needs to know WHICH image the
// pointer is over has to hit-test the geometry. Both callers do (features/drag.ts starts an ⌥ image
// extract from it, features/context-menu.ts builds a right-click menu for it), and they had a copy
// each, differing only in a redundant `.body` in the selector.
export function bodyImageAt(cardEl: HTMLElement, x: number, y: number): HTMLImageElement | null {
  for (const img of cardEl.querySelectorAll<HTMLImageElement>('img.md-img')){
    const r = img.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return img;
    }
  }
  return null;
}
let imgRelayoutTimer: number | undefined;
function scheduleImgRelayout(): void {
  clearTimeout(imgRelayoutTimer);
  imgRelayoutTimer = window.setTimeout(() => { relayout(); }, 60);
}
// `noteFile` is the note the pictures are in: a relative path is read beside it.
export function hydrateImages(el: ParentNode, noteFile?: string | null): void {
  el.querySelectorAll<HTMLImageElement>('img.md-img[data-img-src]').forEach(img => {
    const path = img.getAttribute('data-img-src');
    if (!path) {
      return;
    }
    img.removeAttribute('data-img-src');                 // claim it so repaints don't re-trigger
    const known = knownImageUrl(path, noteFile);
    if (known){ img.src = known; return; }                // known → set, no relayout
    imageUrl(path, noteFile).then(url => {
      if (!url){ img.classList.add('md-img-missing'); img.alt = '⚠ ' + (img.alt || path); return; }
      img.addEventListener('load',  scheduleImgRelayout, { once:true });     // first real load reflows once
      img.addEventListener('error', () => img.classList.add('md-img-missing'), { once:true });
      img.src = url;
    });
  });
}
