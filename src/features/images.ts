// ---------- inline image resolution ----------
// Cards re-render their whole body on every paint, so the <img>s are recreated constantly.
// We resolve each referenced path to a URL ONCE and cache it: vault paths become blob URLs read
// from the active store, remote/data URLs map to themselves. A card that grows when an image
// finally loads triggers a single debounced relayout so siblings/edges re-settle.
// (relayout comes from main.js — a runtime-only cycle.)
import { relayout } from '../main.js';
import { store } from '../data/persistence.js';
import { imageMimeFor } from '../utils/image-types.js';
import { decodePath } from '../utils/markdown.js';
import { dirOf } from '../utils/filenames.js';

// Keyed by the folder of the note that names the picture, then the src as written (`dir\0src`): the same
// `![[cat.png]]` may be a different file in two folders.
const imgUrlCache = new Map<string, string>();    // key -> resolved URL (blob:… or the original remote/data URL)
const imgInflight = new Map<string, Promise<string | null>>();    // key -> in-flight read (de-dupes concurrent reads)
const keyOf = (src: string, noteFile?: string | null): string => (noteFile ? dirOf(noteFile) : '') + '\0' + src;
const srcOfKey = (key: string): string => key.slice(key.indexOf('\0') + 1);
export function resetImageCache(): void {
  for (const url of imgUrlCache.values()) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }
  imgUrlCache.clear(); imgInflight.clear(); byName.clear();
}
// Let go of the pictures only notes that are no longer in memory used (data/lazy.ts releaseFolded):
// their blob URLs are the bulk of what a folded section's notes cost to keep around.
export function forgetImages(paths: Iterable<string>): void {
  const gone = new Set(paths);
  for (const key of [...imgUrlCache.keys(), ...imgInflight.keys()]) {
    if (!gone.has(srcOfKey(key))) {
      continue;
    }
    const url = imgUrlCache.get(key);
    if (url?.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
    imgUrlCache.delete(key); imgInflight.delete(key);
  }
}

// ---------- where a picture a note names actually is ----------
// Every file in the map that isn't a note, by lowercased NAME (a load and each unfold add theirs —
// data/load.ts), so a bare `![[Pasted image.png]]` — Obsidian's "shortest path" — finds its file wherever
// Obsidian put it.
const byName = new Map<string, string[]>();
export function knowAssets(paths: Iterable<string>): void {
  for (const p of paths) {
    const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase(), all = byName.get(name) ?? [];
    if (!all.includes(p)) {
      byName.set(name, [...all, p]);
    }
  }
}
// `a/../b/./c` -> `b/c`.
function normalise(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      out.pop();
    } else if (part && part !== '.') {
      out.push(part);
    }
  }
  return out.join('/');
}
// The paths to try, in the order Obsidian looks: as written, from the map's root (%-encoding read); beside
// the note that names it; then any file of that name in the map.
function candidates(src: string, noteFile?: string | null): string[] {
  const p = normalise(decodePath(src)), dir = noteFile ? dirOf(noteFile) : '';
  const out = [src, p];
  if (dir) {
    out.push(normalise(dir + decodePath(src)));
  }
  out.push(...byName.get(p.slice(p.lastIndexOf('/') + 1).toLowerCase()) ?? []);
  return [...new Set(out.filter(Boolean))];
}
// The picture a note names, read from the store: the path it was found at and its bytes, or null.
export async function readImage(src: string, noteFile?: string | null): Promise<{ path: string; blob: Blob } | null> {
  for (const path of candidates(src, noteFile)) {
    const blob = await store.readBlob(path).catch(() => null);
    if (blob) {
      return { path, blob };
    }
  }
  return null;
}
// Store blobs often come back untyped (OPFS getFile() has no MIME) — give them their real image
// type from the extension, so the blob URL renders as an image when opened in its own tab too.
export function typedImageBlob(blob: Blob, path: string): Blob {
  if (blob.type && blob.type !== 'application/octet-stream') {
    return blob;
  }
  const mime = imageMimeFor(path);
  return mime ? new Blob([blob], { type: mime }) : blob;
}

// A picture a note names as a URL that works OUTSIDE this tab (a formatted copy, features/clipboard.ts): a
// remote/data URL as written, a file in the map as a data URL of its bytes. Null when it can't be read.
export async function portableImageUrl(src: string, noteFile?: string | null): Promise<string | null> {
  if (/^(https?:|data:)/i.test(src)) {
    return src;
  }
  const found = await readImage(src, noteFile);
  if (!found) {
    return null;
  }
  return blobDataUrl(typedImageBlob(found.blob, found.path));
}

function blobDataUrl(blob: Blob): Promise<string | null> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

// A picture a note names -> its resolved URL, through the shared cache: vault paths become blob URLs read
// from the store (once), remote/data URLs map to themselves. Exported for the full-screen viewer,
// which pages through images that may not be on screen — and so may not have been hydrated yet.
export function imageUrl(path: string, noteFile?: string | null): Promise<string | null> {
  const key = keyOf(path, noteFile);
  if (imgUrlCache.has(key)) {
    return Promise.resolve(imgUrlCache.get(key)!);
  }
  if (/^(https?:|data:)/i.test(path)){ imgUrlCache.set(key, path); return Promise.resolve(path); }
  if (imgInflight.has(key)) {
    return imgInflight.get(key)!;
  }
  const p = (async () => {
    const found = await readImage(path, noteFile);
    const blob = found ? typedImageBlob(found.blob, found.path) : null;
    // An SVG is a document that can carry script. In an <img> it never runs — but a blob: URL belongs to
    // this page's origin, so the same file OPENED (the image's own "open in new tab") would run it with
    // the app's storage in reach. A data: URL has no origin to borrow.
    const url = !blob ? null : blob.type === 'image/svg+xml' ? await blobDataUrl(blob) : URL.createObjectURL(blob);
    if (url) {
      imgUrlCache.set(key, url);
    }
    imgInflight.delete(key);
    return url;
  })();
  imgInflight.set(key, p);
  return p;
}
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
    const known = imgUrlCache.get(keyOf(path, noteFile));
    if (known){ img.src = known; return; }                // known → set, no relayout
    imageUrl(path, noteFile).then(url => {
      if (!url){ img.classList.add('md-img-missing'); img.alt = '⚠ ' + (img.alt || path); return; }
      img.addEventListener('load',  scheduleImgRelayout, { once:true });     // first real load reflows once
      img.addEventListener('error', () => img.classList.add('md-img-missing'), { once:true });
      img.src = url;
    });
  });
}
