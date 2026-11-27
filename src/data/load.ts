// Loading a map: every note, its board, and the migrations of older maps.
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

// Holds a line's end that is an unread note.
function standInFor(path: string): string | null {
  return unreadSectionHolding(path)?.id ?? null;
}

const NOTE_READ_W = 720;

export async function loadFromDir({ keepView = false }: { keepView?: boolean } = {}): Promise<void> {
  dataHooks.forgetHistory();   // ids are re-minted per load, so no snapshot survives
  state.nodes.clear(); state.toDelete = [];
  resetSaveState();
  foreignDirs.clear();
  foreignDirs.add('attachments/');   // where pasted pictures go, even before the first one has
  // Section wrappers carry no data-id: with state.nodes cleared, nothing else could reach them.
  world.querySelectorAll('[data-id], .section-content').forEach(e=>e.remove());
  resetImageCache();
  await loadBoard();
  refreshGrid();

  state.idSeq = 1;
  const seeds = newSeeds();
  const added = addListed(await store.listTree('', foldTest(scopeFiles())), seeds);
  // A single note first opens at a reading width rather than a sticky's.
  if (state.singleNote) {
    for (const n of added) {
      if (n.w == null && !boardGeom(n.file!)) {
        n.w = NOTE_READ_W;
      }
    }
  }
  const byPath = settle(added, seeds);
  resolveEdges(byPath, standInFor);
  resolveOrder(byPath);
  // After settle: re-anchoring needs final absolute coordinates.
  const flattened = boardIsLegacy() ? flattenLegacyBranches(seeds.wasStack) : 0;
  const folded = foldCardsIntoSections();
  arrangeSections(unplacedSections(added, seeds), seeds.unplaced);
  // Before the first paint, or a reload inside a section flashes the whole map.
  resolveScopeAfterLoad();
  dataHooks.remeasure();
  if (!keepView) {
    fit();
  }
  // Board first, awaited: a failure between it and the notes would drop the hierarchy AND its edges. If it
  // throws, the notes are left alone and the map migrates again next time.
  if (flattened && store.isOpen) {
    try { await flushBoard(); }
    catch { setStatus('⚠ Could not write board.json — leaving this map as it was.'); return; }
    setStatus(`Converted ${flattened} branch${flattened === 1 ? '' : 'es'} to lines — nothing moved.`);
  }
  if (folded) {
    setStatus(`Turned ${folded} card${folded === 1 ? '' : 's'} with cards inside into section${folded === 1 ? '' : 's'}`);
  }
  // Only when the load settled something: a stable reopen touches no files.
  if (seeds.unplaced.size || flattened || folded || [...state.nodes.values()].some(n => n.dirty)) {
    scheduleSave();
  }
  const notice = takeBoardNotice();
  if (notice) {
    setStatus(notice);
  }
  dataHooks.showMapName();
}
