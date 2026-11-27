// Whether a note's filename still follows its text: a file named elsewhere keeps its name until the text
// changes, since opening a folder must not rename what is in it. See "A file keeps the name it CAME with".
import { type MindNode } from '../core/state.js';
import { pathKey, slugStem, ownStem } from '../utils/filenames.js';

const namedFor = new Map<string, string>();

export function noteNamed(path: string, slug: string): void { namedFor.set(path, slug); }

export function forgetNoteName(path: string): void { namedFor.delete(path); }

export function forgetNoteNames(): void { namedFor.clear(); }

// The name its text gives it, or that with a ` 2` suffix: the app's own name, re-derived as usual.
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
