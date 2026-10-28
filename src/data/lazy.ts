// ============================================================
// FOLDED frames are not read. A frame is a folder (utils/filenames.ts), and while it is folded its
// pill is all the canvas shows of it — so the load leaves its notes on disk (store/tree.ts) and the
// frame carries only how many there are (MindNode.lazy). This module is the POLICY around that:
//   · what has to READ a folder first — unfolding, opening, deleting, copying, exporting, a link into it
//     (afterReading / readAll / revealPath); a save that moves a folded frame reads it itself
//     (data/save.ts saveAll, phase 0);
//   · and when a folded frame LETS GO of what it read again (releaseFolded): once every note under it
//     is safely on disk and nothing — the selection, the undo history, a search result, the frame
//     you are standing in — can still reach one of them.
// The mechanism (turning a listing into nodes) is data/load.ts readFolder's.
// ============================================================
import { state, type MindNode } from '../core/state.js';
import { store } from './persistence.js';
import { rememberGeom, parkEdges } from './board.js';
import { ancestorDepth } from '../view/layout.js';
import { remeasure } from '../main.js';
import { isHidden, nodeByFile, subtreeIds } from '../utils/model.js';
import { bodyImages } from '../utils/markdown.js';
import { historyRefs } from '../features/history.js';
import { searchHolds } from '../features/search.js';
import { forgetImages } from '../features/images.js';
import { scope } from '../nav/scope.js';
import { dirOf } from '../utils/filenames.js';
import { readFolder } from './load.js';

// The folded frames still holding unread notes among `ids` and everything inside them.
function unreadIn(ids: Iterable<string>): MindNode[] {
  const out: MindNode[] = [];
  for (const id of ids) for (const s of subtreeIds(id)) {
    const n = state.nodes.get(s);
    if (n?.lazy != null) out.push(n);
  }
  return out;
}
// Read every unread folder under `ids`, all the way down.
export async function readAll(ids: Iterable<string> = [...state.nodes.keys()]): Promise<void> {
  const roots = [...ids];
  for (let guard = 0, todo = unreadIn(roots); todo.length && guard < 64; guard++, todo = unreadIn(roots))
    for (const f of todo) await readFolder(f, true);
}
// An action that needs the notes of the frames among `ids` (deep: everything under them too): if any
// of them is still unread, read it and run `fn` afterwards, and say so — the caller returns at once.
// Otherwise nothing to wait for: the caller carries on, synchronously, as it always has.
export function afterReading(ids: Iterable<string>, fn: () => void, deep = true): boolean {
  const list = [...ids];
  const todo = deep ? unreadIn(list) : list.map(id => state.nodes.get(id)).filter((n): n is MindNode => n?.lazy != null);
  if (!todo.length) return false;
  void (async () => {
    if (deep) await readAll(list);
    else for (const f of todo) await readFolder(f, false);
    fn();
  })();
  return true;
}
// The innermost UNREAD frame whose folder holds `path`.
export function unreadFrameHolding(path: string): MindNode | null {
  let best: MindNode | null = null;
  for (const n of state.nodes.values()) {
    if (n.lazy != null && n.file && path.startsWith(dirOf(n.file)) && (!best || n.file.length > best.file!.length)) {
      best = n;
    }
  }
  return best;
}

// A path you were sent to (a link, the URL): read the folded frames on the way to it, outermost first,
// until it is in memory or there is nothing left on the way to read.
export async function revealPath(path: string): Promise<void> {
  for (let guard = 0; guard < 64; guard++) {
    if (nodeByFile(path)) {
      return;
    }
    const f = unreadFrameHolding(path);
    if (!f) {
      return;
    }
    await readFolder(f, false);
  }
}

// The safety net: a frame that is OPEN on the canvas while its notes are still unread — an undo that
// unfolded it after it let go of them, say — reads them now (main.ts paintAll asks, every paint; with
// nothing unread that is one pass over the nodes). The canvas repaints once they're in.
let readingOpen = false;
export function readOpenUnread(): void {
  if (readingOpen) return;
  let open: MindNode[] | null = null;
  for (const n of state.nodes.values())
    if (n.lazy != null && (n.id === scope.rootId || (!n.collapsed && !isHidden(n)))) (open ??= []).push(n);
  if (!open) return;
  readingOpen = true;
  void (async () => {
    try { for (const f of open) await readFolder(f, false); }
    finally { readingOpen = false; }
    remeasure();
  })();
}

// ---------- letting go ----------
// Called after every successful save. Read-only and demo mode never let go: demo notes live ONLY in
// memory, and read-only has nothing it could have saved them with.
export function releaseFolded(): void {
  if (!store.isOpen || state.readOnly) return;
  let held: Set<string> | null = null;   // built lazily: most saves have nothing folded to let go of
  const scoped = new Set(scope.stack.map(l => l.rootId));
  // Outermost first: a folded frame inside a folded frame goes with it.
  for (const f of [...state.nodes.values()].sort((a, b) => ancestorDepth(a) - ancestorDepth(b))) {
    if (f.type !== 'frame' || !f.collapsed || f.lazy != null || !f.file || !state.nodes.has(f.id)) continue;
    const kids = subtreeIds(f.id).slice(1).map(id => state.nodes.get(id)!);
    if (!kids.length) continue;
    held ??= historyRefs();
    const h = held;
    const busy = (n: MindNode): boolean => n.dirty || !n.file || h.has(n.id) || state.sel.has(n.id)
      || scoped.has(n.id) || searchHolds(n.id);
    if (scoped.has(f.id)) continue;              // standing inside it: its notes ARE the canvas
    if (kids.some(busy)) continue;
    rememberGeom([f, ...kids]);
    parkEdges(new Map(kids.map(n => [n.id, n.file!])), f.id);
    const pics = new Set<string>();
    for (const n of kids) for (const { src } of bodyImages(n.body)) pics.add(src);
    for (const n of kids) { n.el?.remove(); n.frameContentEl?.remove(); state.nodes.delete(n.id); }
    // …keeping any picture a note still in memory shows too.
    for (const n of state.nodes.values()) for (const { src } of bodyImages(n.body)) pics.delete(src);
    forgetImages(pics);
    f.lazy = kids.reduce((c, n) => c + 1 + (n.lazy ?? 0), 0);   // a folded frame inside counts its own
    f.kidOrder = undefined;
  }
}
