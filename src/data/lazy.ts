// Folded sections' notes stay on disk (MindNode.lazy counts them). This is the policy: what must read a
// folder first, and when a folded section lets go of its notes again (releaseFolded).
import { state, type MindNode } from '../core/state.js';
import { store } from './active-store.js';
import { rememberGeom, parkEdges } from './board.js';
import { ancestorDepth } from '../view/layout.js';
import { dataHooks } from './hooks.js';
import { isHidden, nodeByFile, subtreeIds, ancestors } from '../utils/model.js';
import { bodyImages } from '../utils/markdown.js';
import { forgetImages } from './images.js';
import { scope } from '../nav/scope.js';
import { dirOf } from '../utils/filenames.js';
import { readFolder } from './read.js';

// Walks up from the (few) unread sections: the search asks about every node on every keystroke.
function unreadIn(ids: Iterable<string>): MindNode[] {
  const asked = new Set(ids);
  const out: MindNode[] = [];
  for (const n of state.nodes.values()) {
    if (n.lazy != null && (asked.has(n.id) || [...ancestors(n)].some(a => asked.has(a.id)))) {
      out.push(n);
    }
  }
  return out;
}
export async function readAll(ids: Iterable<string> = [...state.nodes.keys()]): Promise<void> {
  const roots = [...ids];
  for (let guard = 0, todo = unreadIn(roots); todo.length && guard < 64; guard++, todo = unreadIn(roots)) {
    for (const f of todo) {
      await readFolder(f, true);
    }
  }
}
// True: something had to be read, and `fn` runs afterwards (the caller returns). False: carry on now.
export function afterReading(ids: Iterable<string>, fn: () => void, deep = true): boolean {
  const list = [...ids];
  const todo = deep ? unreadIn(list) : list.map(id => state.nodes.get(id)).filter((n): n is MindNode => n?.lazy != null);
  if (!todo.length) {
    return false;
  }
  void (async () => {
    if (deep) {
      await readAll(list);
    } else {
      for (const f of todo) {
        await readFolder(f, false);
      }
    }
    fn();
  })();
  return true;
}
export function unreadSectionHolding(path: string): MindNode | null {
  let best: MindNode | null = null;
  for (const n of state.nodes.values()) {
    if (n.lazy != null && n.file && path.startsWith(dirOf(n.file)) && (!best || n.file.length > best.file!.length)) {
      best = n;
    }
  }
  return best;
}

// A link or URL target: reads the folded sections on the way to it, outermost first.
export async function revealPath(path: string): Promise<void> {
  for (let guard = 0; guard < 64; guard++) {
    if (nodeByFile(path)) {
      return;
    }
    const f = unreadSectionHolding(path);
    if (!f) {
      return;
    }
    await readFolder(f, false);
  }
}

// Safety net, asked on every paint: a section shown open while its notes are unread (say, an undo
// unfolded it) reads them.
let readingOpen = false;
export function readOpenUnread(): void {
  if (readingOpen) {
    return;
  }
  let open: MindNode[] | null = null;
  for (const n of state.nodes.values()) {
    if (n.lazy != null && (n.id === scope.rootId || (!n.collapsed && !isHidden(n)))) {
      (open ??= []).push(n);
    }
  }
  if (!open) {
    return;
  }
  readingOpen = true;
  void (async () => {
    try {
      for (const f of open) {
        await readFolder(f, false);
      }
    }
    finally { readingOpen = false; }
    dataHooks.remeasure();
  })();
}

// After every successful save, for notes nothing can still reach. Demo mode's notes live only in memory.
export function releaseFolded(): void {
  if (!store.isOpen || dataHooks.searchHolds()) {
    return;
  }
  let held: Set<string> | null = null;   // built lazily: most saves have nothing to let go of
  const scoped = new Set(scope.stack.map(l => l.rootId));
  // Outermost first: a folded section inside a folded section goes with it.
  for (const f of [...state.nodes.values()].sort((a, b) => ancestorDepth(a) - ancestorDepth(b))) {
    if (f.type !== 'section' || !f.collapsed || f.lazy != null || !f.file || !state.nodes.has(f.id)) {
      continue;
    }
    const kids = subtreeIds(f.id).slice(1).map(id => state.nodes.get(id)!);
    if (!kids.length) {
      continue;
    }
    held ??= dataHooks.historyRefs();
    const h = held;
    const busy = (n: MindNode): boolean => n.dirty || !n.file || h.has(n.id) || state.sel.has(n.id)
      || scoped.has(n.id);
    if (scoped.has(f.id)) {
      continue;
    }
    if (kids.some(busy)) {
      continue;
    }
    rememberGeom([f, ...kids]);
    parkEdges(new Map(kids.map(n => [n.id, n.file!])), f.id);
    const pics = new Set<string>();
    for (const n of kids) {
      for (const { src } of bodyImages(n.body)) {
        pics.add(src);
      }
    }
    for (const n of kids) { n.el?.remove(); n.sectionContentEl?.remove(); state.nodes.delete(n.id); }
    // …except pictures a note still in memory shows.
    for (const n of state.nodes.values()) {
      for (const { src } of bodyImages(n.body)) {
        pics.delete(src);
      }
    }
    forgetImages(pics);
    f.lazy = kids.reduce((c, n) => c + 1 + (n.lazy ?? 0), 0);
    f.lazySections = kids.reduce((c, n) => c + (n.type === 'section' ? 1 : 0) + (n.lazySections ?? 0), 0);
    f.kidOrder = undefined;
  }
}
