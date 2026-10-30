// ============================================================
// A note's FILENAME: the slug its text gives it, the collision rule, and the [[wikilink]] fixup a
// rename drags along. Pure — no state, no store — so data/save.ts saveAll can lean on it and
// the tests (tests/filenames.test.ts) can pin it down without a DOM.
// ============================================================
import type { MindNode } from '../core/state.js';
import { firstLineLabel, fileStem } from './frontmatter.js';
import { soleImage } from './markdown.js';

// title -> safe filename component: no path separators or illegal chars — and no leading or trailing
// dot or space, and no `..`. A leading dot makes a HIDDEN file (Finder, Obsidian and `ls` all skip it),
// and a first line that is a sentence ended its filename in `move..md`.
export function safeName(title: string): string {
  const s = title.trim().replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g,' ').replace(/\.{2,}/g, '.')
    .slice(0,120).replace(/^[.\s]+|[.\s]+$/g, '');
  return s || 'Untitled';
}
// The filename a node SHOULD have, given its title, keeping its current directory.
//
// The filename is a SLUG, not the node's identity any more — the title lives in the note itself (the
// body's leading heading, utils/frontmatter.ts splitHeading), so this is free to suffix a colliding
// name without that suffix ever being read back as part of the title. Which is what lets two cards
// share a title: `Notes.md` and `Notes 2.md`, both titled "Notes".
//
// The slug TRACKS the text: it is re-derived on every save, so a card's filename always reads as the
// name the card shows — its heading, else its first line. It used to be minted once and left to go
// stale, which meant an ordinary card (untitled, its text edited into shape after it was created) kept
// whatever name it had at its very first autosave — `Untitled 12.md` for life. Tracking costs a rename
// per edit that changes the first line, and what records a path follows it: a section's folder takes its
// notes along (saveAll phase 1) and the inbound [[wikilinks]] are re-pointed (phase 1b). Not a rename PER
// KEYSTROKE, though: while any editor holds the note's text the name is frozen (ui-state.ts
// frozenFileNodeId), so the rename lands once, when the edit session commits.
// The bare slug a node's own text gives it, with no directory and no `.md` — the ONE spelling of that
// rule, shared with exportZip, which has to name never-saved nodes the same way.
// An IMAGE card (a card holding nothing but one `![alt](src)`) is named after the PICTURE: its alt
// text, else the image file's own stem. firstLineLabel would hand back the raw `![](attachments/…)`
// markup, which slugifies into something no one can read in a folder listing — and the note has no
// other text to be named from, so this is the one kind of body worth reading structurally.
export function slugStem(n: Pick<MindNode, 'title' | 'body'>): string {
  const img = soleImage(n.body);
  if (!n.title.trim() && img) {
    return safeName(img.alt || fileStem(img.src) || 'image');
  }
  return safeName(n.title.trim() || firstLineLabel(n.body));
}
// ---------- a SECTION is a FOLDER ----------
// The tree is the folder tree: a card is `<folder>/<slug>.md`, a section is the folder `<folder>/<slug>/`
// holding its own note as SECTION_NOTE plus everything inside it. So a node's parent is never written
// down — it is read off the path (parentFileOf), and moving a card into a section MOVES its file.
export const SECTION_NOTE = '_index.md';
// Is this path a section's own note? Case-insensitive, like every other path test here.
export function isSectionNote(path: string): boolean {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase() === SECTION_NOTE;
}
// The directory a path sits in, with its trailing slash ('' at the top level).
export function dirOf(path: string): string { return path.slice(0, path.lastIndexOf('/') + 1); }
// The folder a node's CHILDREN live in: a section's own folder; for anything else, the folder it sits in
// (a card holds no cards, so that is only ever asked of a card by a legacy, not-yet-migrated tree).
export function folderOf(path: string): string { return dirOf(path); }
// The section note a path belongs to, or null for the top level. A section's parent is the section of the
// folder ABOVE its own; anything else's is the section of the folder it sits in.
export function parentFileOf(path: string): string | null {
  let dir = dirOf(path);
  if (isSectionNote(path)) {
    dir = dirOf(dir.slice(0, -1));
  }
  return dir ? dir + SECTION_NOTE : null;
}
// The name a node goes by in its folder, without the folder: a section's folder name, a card's stem.
function ownStem(path: string, section: boolean): string {
  if (section && isSectionNote(path)) { const d = dirOf(path).slice(0, -1); return d.slice(d.lastIndexOf('/') + 1); }
  return fileStem(path);
}

// `inUse` is the lowercased filename -> node id index the collision test reads (persistence.ts
// filesInUse), built ONCE per save rather than re-derived per candidate name.
// `dir` is the folder the node belongs in — its parent section's folder, '' at the top level. Left out,
// the node stays in the folder it is in. `reserved` holds lowercased folders on disk that are NOT
// sections (`attachments/`, a dot-folder): a section must not move into one of those and adopt its files.
export function desiredFileFor(n: Pick<MindNode, 'id' | 'file' | 'title' | 'body'> & { type?: MindNode['type']; stack?: boolean },
                               inUse: Map<string, string>, dir?: string, reserved?: Set<string>): string {
  const section = n.type === 'section';
  const at = dir ?? (n.file ? (section && isSectionNote(n.file) ? dirOf(dirOf(n.file).slice(0, -1)) : dirOf(n.file)) : '');
  let stem = slugStem(n);
  // Nothing in the note to be named off — `Untitled` is safeName's fallback for an empty string, so
  // this is a card with no heading, no text and no picture. Keep the name it already has: there is
  // nothing to track, and renaming it would only renumber it as its neighbours come and go. A card the
  // user just CLEARED therefore keeps the slug it was named under, which utils/model.ts namelessLabel
  // leans on — the stem is the name they deleted, so nothing shows it to them again.
  if (stem === 'Untitled' && n.file) {
    stem = ownStem(n.file, section);
  } else if (stem === 'Untitled' && n.stack) {
    stem = 'Stack';   // a new pile's folder: `Stack`, `Stack 2`, …
  }
  const pathFor = (s: string): string => section ? at + s + '/' + SECTION_NOTE : at + s + '.md';
  // Avoid clobbering a DIFFERENT node that already uses this filename — case-INSENSITIVELY, since
  // that's how the filesystem collides on macOS/Windows: "Notes" and "notes" are one file there, so
  // an exact-match test would hand both nodes "their own" name and let the second write eat the first.
  // A card may not be called `_index` (it would BE its folder's section note), and a section may not take
  // a folder that is already something else's.
  const taken = (s: string): boolean => {
    if (!section && s.toLowerCase() === SECTION_NOTE.slice(0, -3)) {
      return true;
    }
    if (section && reserved?.has((at + s + '/').toLowerCase())) {
      return true;
    }
    const owner = inUse.get(pathFor(s).toLowerCase());
    return owner !== undefined && owner !== n.id;
  };
  let i = 2, s = stem;
  while (taken(s)) {
    s = stem + ' ' + (i++);
  }

  // A rename that only changes CASE keeps the old name: on macOS/Windows `Notes.md` and `notes.md` are
  // one file, so saveAll would write the new name and then delete the old one, which is the same file.
  const path = pathFor(s);
  return n.file && path.toLowerCase() === n.file.toLowerCase() ? n.file : path;
}

// Re-point the PATH-form [[wikilinks]] in one body that name a file a save just renamed, so a link
// written before the rename still resolves after it (utils/model.ts resolveWikilink matches a target
// against the node's path, `.md` optional). Only the path form moves: a `[[Title]]` names the title,
// which re-slugging a file never touches — and the keys here are whole paths, so a bare title can only
// collide with one by BEING that path, which resolveWikilink already reads path-first anyway.
// The alias half is carried through verbatim: `[[Untitled 7|see this]]` keeps the words the reader sees.
// `renames` maps old path -> new path; returns the body unchanged (the same string) if nothing moved.
export function retargetLinks(body: string, renames: Map<string, string>): string {
  if (!renames.size) {
    return body;
  }
  const dropMd = (path: string): string => path.replace(/\.md$/i, '');
  const to = new Map<string, string>();   // old path, no `.md`, lowercased -> new path, no `.md`
  for (const [from, into] of renames) {
    to.set(dropMd(from).toLowerCase(), dropMd(into));
  }
  // Same shape as the renderer's wikilink arm (utils/markdown.ts mdInline).
  return body.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (m, target: string, alias?: string) => {
    const into = to.get(dropMd(target.trim()).toLowerCase());
    return into ? `[[${into}${alias ?? ''}]]` : m;
  });
}

// The folders to try removing after notes left `emptied` folders: each of those and every folder above
// it, deepest first (emptying `A/B/` can empty `A/`), but never one that still holds a note in `held`.
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
