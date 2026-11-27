// A note's FILENAME: the slug its text gives it, collisions, and the link fixup a rename drags along.
import type { MindNode } from '../core/state.js';
import { firstLineLabel, fileStem } from './frontmatter.js';
import { soleImage } from './markdown.js';

// macOS and Windows fold case, and macOS also folds the two Unicode spellings of an accented letter.
export function pathKey(path: string): string { return path.normalize('NFC').toLowerCase(); }

// A filename may be 255 BYTES; this leaves room for `.md` and a ` 12` suffix.
const MAX_STEM_BYTES = 200, MAX_STEM_CHARS = 120;

// Cut per CODE POINT: half an emoji is stored as something else, and the name would stop matching.
function clipStem(s: string): string {
  if (s.length * 3 <= MAX_STEM_BYTES) {
    return s;   // no UTF-16 unit takes more than three bytes
  }
  let out = '', bytes = 0, chars = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (++chars > MAX_STEM_CHARS || bytes > MAX_STEM_BYTES) {
      break;
    }
    out += ch;
  }
  return out;
}

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// No leading/trailing dot or space (a leading dot HIDES the file) and no `..` (`move..md`).
export function safeName(title: string): string {
  const s = clipStem(title.normalize('NFC')

    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, ' ')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .trim().replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').replace(/\.{2,}/g, '.'))
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (WINDOWS_DEVICE_NAME.test(s)) {
    return s + '_';
  }
  return s || 'Untitled';
}

// The slug TRACKS the text (renamed on edit-commit, see `keepsName`). An image card is named after its
// picture: its alt text, else the file's stem, never the raw `![](…)` markup.
export function slugStem(n: Pick<MindNode, 'title' | 'body'>): string {
  const img = soleImage(n.body);
  if (!n.title.trim() && img) {
    return safeName(img.alt || fileStem(img.src) || 'image');
  }
  return safeName(n.title.trim() || firstLineLabel(n.body));
}

// A SECTION is a FOLDER holding its own note as SECTION_NOTE; a parent is read off the path, never written.
export const SECTION_NOTE = '_index.md';

export function isSectionNote(path: string): boolean {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase() === SECTION_NOTE;
}

// With its trailing slash ('' at the top level).
export function dirOf(path: string): string { return path.slice(0, path.lastIndexOf('/') + 1); }

// Where a node's CHILDREN live (asked of a card only by a not-yet-migrated tree).
export function folderOf(path: string): string { return dirOf(path); }

// A section's parent is the section of the folder ABOVE its own.
export function parentFileOf(path: string): string | null {
  let dir = dirOf(path);
  if (isSectionNote(path)) {
    dir = dirOf(dir.slice(0, -1));
  }
  return dir ? dir + SECTION_NOTE : null;
}

// A section's folder name, a card's stem.
export function ownStem(path: string, section: boolean): string {
  if (section && isSectionNote(path)) { const d = dirOf(path).slice(0, -1); return d.slice(d.lastIndexOf('/') + 1); }
  return fileStem(path);
}

// `inUse`: pathKey -> node id, built once per save. `dir`: the target folder (default: where it is).
// `reserved`: non-section folders a section must not adopt. `keepName`: only settle the folder.
export function desiredFileFor(n: Pick<MindNode, 'id' | 'file' | 'title' | 'body'> & { type?: MindNode['type']; stack?: boolean },
                               inUse: Map<string, string>, dir?: string, reserved?: Set<string>, keepName = false): string {
  const section = n.type === 'section';
  const at = dir ?? (n.file ? (section && isSectionNote(n.file) ? dirOf(dirOf(n.file).slice(0, -1)) : dirOf(n.file)) : '');
  let stem = slugStem(n);

  // Nothing to name it off: keep the name it has, so a cleared card keeps its slug.
  if ((stem === 'Untitled' || keepName) && n.file) {
    stem = ownStem(n.file, section);
  } else if (stem === 'Untitled' && n.stack) {
    stem = 'Stack';
  }
  const pathFor = (s: string): string => section ? at + s + '/' + SECTION_NOTE : at + s + '.md';

  // Collide case-INSENSITIVELY, as macOS/Windows do. A card may not be `_index` (it would BE the section
  // note), and a section may not take a folder that is something else's.
  const taken = (s: string): boolean => {
    if (!section && s.toLowerCase() === SECTION_NOTE.slice(0, -3)) {
      return true;
    }
    if (section && reserved?.has(pathKey(at + s + '/'))) {
      return true;
    }
    const owner = inUse.get(pathKey(pathFor(s)));
    return owner !== undefined && owner !== n.id;
  };
  let i = 2, s = stem;
  while (taken(s)) {
    s = stem + ' ' + (i++);
  }

  // A case-only rename keeps the old name: on macOS/Windows the old and new are one file, and saveAll
  // would delete it after writing it.
  const path = pathFor(s);
  return n.file && pathKey(path) === pathKey(n.file) ? n.file : path;
}

// Re-points links to renamed files: a whole path (`[[Ideas/Old]]`, `[x](Ideas/Old.md)`), or a path's
// END (`[[Old]]`) when nothing in `existing` answers to it. Title matches are left alone. Returns the
// same string if nothing moved.
export function retargetLinks(body: string, renames: Map<string, string>, existing: Set<string> = new Set()): string {
  if (!renames.size) {
    return body;
  }
  const dropMd = (path: string): string => path.replace(/\.md$/i, '');
  const to = new Map<string, string>();   // old path, lowercased -> new path, both without `.md`
  for (const [from, into] of renames) {
    to.set(dropMd(from).toLowerCase(), dropMd(into));
  }
  const retarget = (target: string): string | null => {
    const key = dropMd(target.trim()).toLowerCase();
    const whole = to.get(key);
    if (whole) {
      return whole;
    }
    if (!key || existing.has(key) || [...existing].some(e => e.endsWith('/' + key))) {
      return null;
    }
    const hits = [...to].filter(([from]) => from.endsWith('/' + key));
    return hits.length === 1 ? hits[0][1].split('/').slice(-key.split('/').length).join('/') : null;
  };

  // Same shapes as mdLinks.
  return body
    .replace(/\[\[([^\]|#^]+)([#^][^\]|]*)?(\|[^\]]*)?\]\]/g, (m, target: string, place?: string, alias?: string) => {
      const into = retarget(target);
      return into ? `[[${into}${place ?? ''}${alias ?? ''}]]` : m;
    })
    .replace(/(\[[^\]]*\]\()(<[^<>\n]+>|[^()\s]+)\)/g, (m, head: string, dest: string) => {
      const angled = dest.startsWith('<'), raw = angled ? dest.slice(1, -1) : dest;
      let path = raw;
      try {
        path = decodeURIComponent(raw);
      } catch { /* not %-encoded: read as written */ }
      const parts = path.match(/^((?:\.\.?\/)*)([^:#?]+?)\.md(#.*)?$/i);
      const into = parts && retarget(parts[2]);
      if (!parts || !into) {
        return m;
      }
      const out = `${parts[1]}${into}.md${parts[3] ?? ''}`;
      if (angled) {
        return `${head}<${out}>)`;
      }
      return `${head}${raw.includes('%') ? encodeURI(out) : /\s/.test(out) ? `<${out}>` : out})`;
    });
}

// Each emptied folder and every one above it, deepest first, unless it still holds a note.
export function prunableDirs(emptied: Iterable<string>, held: Iterable<string | null>): string[] {
  const live = new Set<string>();
  for (const f of held) {
    for (let d = f ? dirOf(f) : ''; d; d = dirOf(d.slice(0, -1))) {
      live.add(d);
    }
  }
  const dirs = new Set<string>();
  for (const d0 of emptied) {
    for (let d = d0; d; d = dirOf(d.slice(0, -1))) {
      dirs.add(d);
    }
  }
  return [...dirs].filter(d => !live.has(d)).sort((a, b) => b.length - a.length);
}
