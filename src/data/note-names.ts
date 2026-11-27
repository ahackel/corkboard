// ---------- whether a note's filename still follows its text ----------
// What each note's filename was last SETTLED against: the slug its text gave it then. A name that says
// something else than the text — `2026-11-11.md` in someone's Obsidian vault, a file named in Finder —
// is left alone until that text changes: opening a folder must not rename what is in it.
// A load records each note it reads (data/read.ts); a save each name it settles (data/save.ts).
import { type MindNode } from '../core/state.js';
import { pathKey, slugStem, ownStem } from '../utils/filenames.js';

const namedFor = new Map<string, string>();

export function noteNamed(path: string, slug: string): void { namedFor.set(path, slug); }

export function forgetNoteName(path: string): void { namedFor.delete(path); }

export function forgetNoteNames(): void { namedFor.clear(); }

// Does the file already carry the name its text gives it (or that name with a ` 2` suffix)? Then it is
// the app's own name, and is re-derived as before — a suffix goes once the plain name is free.
function tracksText(n: MindNode, slug: string): boolean {
  const own = pathKey(ownStem(n.file!, n.type === 'section')), want = pathKey(slug);
  return own === want || (own.startsWith(want + ' ') && /^\d+$/.test(own.slice(want.length + 1)));
}

export function keepsName(n: MindNode): boolean {
  if (!n.file) {
    return false;
  }
  const slug = slugStem(n);
  return namedFor.get(n.file) === slug && !tracksText(n, slug);
}
