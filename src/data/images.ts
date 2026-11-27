// The picture cache: each path a note names resolves to a URL once (a blob URL for a file in the map),
// since card bodies are re-rendered constantly.
import { store } from './active-store.js';
import { imageMimeFor } from '../utils/image-types.js';
import { decodePath } from '../utils/markdown.js';
import { dirOf } from '../utils/filenames.js';

// Keyed `dir\0src`: the same `![[cat.png]]` may be a different file in two folders.
const imgUrlCache = new Map<string, string>();
const imgInflight = new Map<string, Promise<string | null>>();
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
// For notes let go of (releaseFolded): their blob URLs are the bulk of what they cost to keep.
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

// Every non-note file by lowercased NAME, so Obsidian's bare `![[Pasted image.png]]` finds its file anywhere.
const byName = new Map<string, string[]>();
export function knowAssets(paths: Iterable<string>): void {
  for (const p of paths) {
    const name = p.slice(p.lastIndexOf('/') + 1).toLowerCase(), all = byName.get(name) ?? [];
    if (!all.includes(p)) {
      byName.set(name, [...all, p]);
    }
  }
}
// `a/../b/./c` → `b/c`.
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
// In Obsidian's order: from the map's root, beside the note, then any file of that name.
function candidates(src: string, noteFile?: string | null): string[] {
  const p = normalise(decodePath(src)), dir = noteFile ? dirOf(noteFile) : '';
  const out = [src, p];
  if (dir) {
    out.push(normalise(dir + decodePath(src)));
  }
  out.push(...byName.get(p.slice(p.lastIndexOf('/') + 1).toLowerCase()) ?? []);
  return [...new Set(out.filter(Boolean))];
}
export async function readImage(src: string, noteFile?: string | null): Promise<{ path: string; blob: Blob } | null> {
  for (const path of candidates(src, noteFile)) {
    const blob = await store.readBlob(path).catch(() => null);
    if (blob) {
      return { path, blob };
    }
  }
  return null;
}
// OPFS getFile() has no MIME, and an untyped blob URL won't render as an image in its own tab.
export function typedImageBlob(blob: Blob, path: string): Blob {
  if (blob.type && blob.type !== 'application/octet-stream') {
    return blob;
  }
  const mime = imageMimeFor(path);
  return mime ? new Blob([blob], { type: mime }) : blob;
}

// A URL that works outside this tab (a formatted copy).
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

export function knownImageUrl(path: string, noteFile?: string | null): string | undefined {
  return imgUrlCache.get(keyOf(path, noteFile));
}

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
    // An SVG can carry script: a blob: URL opened in its own tab would run it with this origin's storage
    // in reach. A data: URL has no origin to borrow.
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
