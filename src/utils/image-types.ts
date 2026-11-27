// The picture formats a note can hold, by extension: every image check reads this one list.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
const EXTS = Object.keys(IMAGE_MIME);

export const IMAGE_FILE_RE = new RegExp(`\\.(${EXTS.join('|')})$`, 'i');

// The same endings, allowing a `?query` after them.
export const IMAGE_URL_RE = new RegExp(`\\.(${EXTS.join('|')})(\\?\\S*)?$`, 'i');

// For a file input's `accept`.
export const IMAGE_ACCEPT = EXTS.map(e => '.' + e).join(',');

export function imageMimeFor(path: string): string | undefined {
  return IMAGE_MIME[(path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()];
}

// `.png` for a type that isn't a picture format.
export function imageExtFor(mime: string): string {
  return '.' + (EXTS.find(e => IMAGE_MIME[e] === mime) ?? 'png');
}
