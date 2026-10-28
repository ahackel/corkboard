// What to READ of a map's folder tree, decided from the file NAMES alone — pure, shared by every store
// (the handle-based ones list names cheaply and read only what this picks; the IndexedDB one has every
// key in hand anyway) and pinned by tests/tree.test.ts.
//
// A frame is a folder (utils/filenames.ts FRAME_NOTE). A FOLDED frame's contents are not read at all:
// `fold` is asked once per folder, outermost first, and a folder it answers yes for is LAZY — only its
// own frame note is read, and the notes under it are merely COUNTED, for the pill. Nothing below a lazy
// folder is asked about, since nothing below it is read.
import { FRAME_NOTE } from '../utils/filenames.js';

export interface LazyFolder { count: number; hasIndex: boolean; }
export interface TreePlan {
  read: string[];                      // the .md paths to read, in listing order
  lazy: Map<string, LazyFolder>;       // folder ('A/B/') -> its unread notes
  foreign: Set<string>;                // lowercased folders holding no notes at all: not frames
}
export type FoldTest = (dir: string, hasIndex: boolean) => boolean;

// `paths` are every file under `under` ('' for the whole map), dot-folders already left out.
export function planTree(paths: string[], under: string, fold: FoldTest): TreePlan {
  const md = paths.filter(p => /\.md$/i.test(p));
  const mdCount = new Map<string, number>();   // folder -> .md files anywhere under it
  const index = new Map<string, string>();     // folder -> the exact path of its frame note
  const dirs = new Set<string>();
  const dirsOf = (p: string): string[] => {
    const out: string[] = [];
    for (let i = p.indexOf('/', under.length); i >= 0; i = p.indexOf('/', i + 1)) {
      out.push(p.slice(0, i + 1));
    }
    return out;
  };
  for (const p of paths) {
    for (const d of dirsOf(p)) {
      dirs.add(d);
    }
  }
  for (const p of md) {
    for (const d of dirsOf(p)) {
      mdCount.set(d, (mdCount.get(d) ?? 0) + 1);
    }
    const slash = p.lastIndexOf('/');
    if (slash >= under.length && p.slice(slash + 1).toLowerCase() === FRAME_NOTE) {
      index.set(p.slice(0, slash + 1), p);
    }
  }
  const lazy = new Map<string, LazyFolder>(), foreign = new Set<string>();
  const depth = (d: string): number => d.split('/').length;
  for (const d of [...dirs].sort((a, b) => depth(a) - depth(b))) {
    const n = mdCount.get(d) ?? 0;
    if (!n) { foreign.add(d.toLowerCase()); continue; }
    if ([...lazy.keys()].some(l => d.startsWith(l))) {
      continue;   // inside a folder nobody reads
    }
    const hasIndex = index.has(d);
    if (fold(d, hasIndex)) {
      lazy.set(d, { count: n - (hasIndex ? 1 : 0), hasIndex });
    }
  }
  const lazyDirs = [...lazy.keys()];
  const read = md.filter(p => {
    const l = lazyDirs.find(d => p.startsWith(d));
    return !l || index.get(l) === p;          // a lazy folder still gives up its own frame note
  });
  return { read, lazy, foreign };
}
