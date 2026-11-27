// Puts picture URLs (from the data/images.ts cache) into cards, reflowing once a picture loads.
import { relayout } from '../render.js';
import { imageUrl, knownImageUrl } from '../data/images.js';

const IMG_RELAYOUT_DELAY_MS = 60;

// Body images are `pointer-events:none`, so which one is under the pointer is a geometry hit-test.
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
  imgRelayoutTimer = window.setTimeout(() => { relayout(); }, IMG_RELAYOUT_DELAY_MS);
}

// A relative picture path is read beside `noteFile`.
export function hydrateImages(el: ParentNode, noteFile?: string | null): void {
  el.querySelectorAll<HTMLImageElement>('img.md-img[data-img-src]').forEach(img => {
    const path = img.getAttribute('data-img-src');
    if (!path) {
      return;
    }
    img.removeAttribute('data-img-src');
    const known = knownImageUrl(path, noteFile);
    if (known){ img.src = known; return; }
    imageUrl(path, noteFile).then(url => {
      if (!url){ img.classList.add('md-img-missing'); img.alt = '⚠ ' + (img.alt || path); return; }
      img.addEventListener('load',  scheduleImgRelayout, { once:true });
      img.addEventListener('error', () => img.classList.add('md-img-missing'), { once:true });
      img.src = url;
    }).catch(() => img.classList.add('md-img-missing'));
  });
}
