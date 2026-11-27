// ---------- loading a map: every note, its board, and the migrations of older maps ----------
import { state, world, setStatus } from '../core/state.js';
import { boardGeom, loadBoard, resolveEdges, resolveOrder, boardIsLegacy, flushBoard, takeBoardNotice } from './board.js';
import { unreadSectionHolding } from './lazy.js';
import { resolveScopeAfterLoad } from '../nav/scope.js';
import { dataHooks } from './hooks.js';
import { resetSaveState, scheduleSave } from './save.js';
import { resetImageCache } from './images.js';
import { refreshGrid } from '../view/grid.js';
import { store } from './active-store.js';
import { flattenLegacyBranches, foldCardsIntoSections } from './migrate.js';
import { arrangeSections } from './arrange.js';
import { newSeeds, addListed, settle, foldTest, foreignDirs, scopeFiles, unplacedSections } from './read.js';
import { fit } from '../view/camera.js';

// The section an unread note sits in, for a line that ends on it: the deepest folded section in memory
// whose folder holds the path (data/board.ts resolveEdges).
function standInFor(path: string): string | null {
  return unreadSectionHolding(path)?.id ?? null;
}

const NOTE_READ_W = 720;

export async function loadFromDir({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  dataHooks.forgetHistory();   // ids are minted fresh per load, so no snapshot survives a (re)load / map switch
  // …including the container wrappers, which carry no data-id: a section's clipping wrapper
  // hangs off the NODE object (sectionContentEl), so once state.nodes is
  // cleared nothing can reach the old ones to remove them and they'd pile up in #world on every load.
  state.nodes.clear(); state.toDelete = [];
  resetSaveState();
  foreignDirs.clear();
  foreignDirs.add('attachments/');   // where pasted pictures go, even before the first one has
  world.querySelectorAll('[data-id], .section-content').forEach(e=>e.remove());
  resetImageCache();   // blob URLs from the previous map (or store) are stale now
  await loadBoard();   // edges + ink layer + view prefs for this map (board.json), if any
  refreshGrid();

  // Read every note — except the insides of FOLDED sections, which stay on disk until unfolded.
  // Ids are ephemeral (minted fresh each load) since the path is the real identity.
  state.idSeq = 1;
  const seeds = newSeeds();
  const added = addListed(await store.listTree('', foldTest(scopeFiles())), seeds);
  // A note opened ON ITS OWN (store/note.ts) is a document: the first time, it opens at a reading width
  // rather than a sticky's. After that its width is whatever was saved, like any card's.
  if (state.singleNote) {
    for (const n of added) {
      if (n.w == null && !boardGeom(n.file!)) {
        n.w = NOTE_READ_W;
      }
    }
  }
  const byPath = settle(added, seeds);
  resolveEdges(byPath, standInFor);   // the board's edges hold paths too — same index, same drop-if-missing rule
  resolveOrder(byPath);   // …and so does each parent's stored child order
  // A map written before containment: its card-to-card links meant "beside", not "inside". Convert
  // them now that every node has final absolute coordinates to be re-anchored from.
  const flattened = boardIsLegacy() ? flattenLegacyBranches(seeds.wasStack) : 0;
  // …and cards no longer hold cards: any card that still has children becomes a section holding them.
  const folded = foldCardsIntoSections();
  arrangeSections(unplacedSections(added, seeds), seeds.unplaced);
  // Re-point the open-section scope at the freshly minted ids BEFORE the first layout/paint, so a
  // reload that happens while you're inside a section lays out scoped straight away — no flash of the
  // whole map (nav/scope.ts).
  resolveScopeAfterLoad();
  dataHooks.remeasure();   // paint so every card has a real measured height, settle, and paint again
  if (!keepView) {
    fit();
  }
  // A migration is persisted BOARD FIRST, and awaited: the new edges and the model stamp have to be
  // on disk before any note moves into its section's folder, or a failed write between the two would drop the
  // hierarchy AND the edges that replaced it. If the board write throws, the notes are left alone and
  // the map simply migrates again next time — the conversion is a pure function of what's on disk.
  if (flattened && store.isOpen) {
    try { await flushBoard(); }
    catch { setStatus('⚠ Could not write board.json — leaving this map as it was.'); return; }
    setStatus(`Converted ${flattened} branch${flattened === 1 ? '' : 'es'} to lines — nothing moved.`);
  }
  if (folded) {
    setStatus(`Turned ${folded} card${folded === 1 ? '' : 's'} with cards inside into section${folded === 1 ? '' : 's'}`);
  }
  // Persist what the load itself settled — a note placed for the first time, a migration, a body-less
  // note given its heading — so the disk matches what's on screen. Only then: a stable reopen touches no files.
  if (seeds.unplaced.size || flattened || folded || [...state.nodes.values()].some(n => n.dirty)) {
    scheduleSave();
  }
  const notice = takeBoardNotice();
  if (notice) {
    setStatus(notice);
  }
  dataHooks.showMapName();
}
