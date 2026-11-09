// ============================================================
// Which map is open: the active `store` adapter (reassigned by useStore), switching maps, and the
// reload when the folder changed underneath us. Reading a map is data/load.ts, saving it
// data/save.ts (every mutation calls scheduleSave()), the .zip import/export data/zip-io.ts.
// ============================================================
import { state } from '../core/state.js';
import { opfsStore, fsaStore, noteStore, resolveOnDeviceStore, setLastMap, touchMap, type Store, type MapKind, type MapRef } from '../store/index.js';
import { flashArrived } from '../main.js';
import { updateDocumentTitle } from '../nav/url-state.js';
import { isTypingInField, inPlaceEditActive } from '../core/ui-state.js';
import { paintMapCrumb } from '../features/breadcrumbs.js';
import { selectNode } from '../features/selection.js';
import { settleSave, hasUnsavedChanges } from './save.js';
import { loadFromDir } from './load.js';
import { nodeByFile } from '../utils/model.js';

// Everything that is about the BOARD rather than about a note — the free edges, the ink layer, the
// per-map view prefs — lives in one board.json beside the notes; see data/board.ts, which owns its
// I/O and its own debounce. Only the .md walk in the store filters by extension, so that file is
// invisible to the node model.

// Active backend. Local-first: default to on-device; "Open folder" swaps in fsaStore.
// `ref` identifies WHICH map is now open (registry entry + what boot() reopens); omit it
// for stores that aren't registry-backed.
// eslint-disable-next-line import-x/no-mutable-exports -- a live binding, reassigned only by useStore (follow-up: a getter)
export let store: Store = opfsStore;
// Which map is on the canvas RIGHT NOW — in-memory runtime state, unlike the persisted
// last-map key (which another tab may rewrite). null for non-registry stores.
// eslint-disable-next-line import-x/no-mutable-exports -- a live binding, reassigned only by useStore (follow-up: a getter)
export let currentMap: { kind: MapKind; id: string } | null = null;
export function useStore(s: Store, ref?: { kind: MapKind; id: string }): void {
  store = s; store.watch(reloadFromDisk);
  currentMap = ref ?? null;
  // A single note (store/note.ts) is a map of one card: the dock's new-card sticky goes (styles.css).
  state.singleNote = !!s.singleNote;
  document.body.classList.toggle('single-note', state.singleNote);
  if (ref) { setLastMap(ref.kind, ref.id); touchMap(ref.id); }
}

// Retarget the app at another on-device map. settleSave MUST come first — a straggling
// autosave firing after the adapter retargets would write the old map's files into the new one.
export async function switchToDeviceMap(ref: MapRef): Promise<void> {
  await settleSave();
  const s = await resolveOnDeviceStore();
  s.openMap(ref.id, ref.name);
  await s.pick();
  useStore(s, { kind: 'device', id: ref.id });
}

// Open a registry-backed map for URL/history restoration. Device maps can always be reopened;
// local folders only switch when their existing permission grant can be resumed silently.
export async function openMapRef(ref: MapRef): Promise<boolean> {
  if (currentMap?.kind === ref.kind && currentMap.id === ref.id && store.isOpen) {
    return true;
  }
  if (ref.kind === 'device') {
    await switchToDeviceMap(ref);
    await loadFromDir();
    return true;
  }
  await settleSave();
  if (ref.kind === 'note') {
    if (!(await noteStore.resume(ref.id))) {
      return false;
    }
    await loadNote(ref.id);
    return true;
  }
  if (!(await fsaStore.resume(ref.id))) {
    return false;
  }
  await loadFolder(ref.id);
  return true;
}

// Make the FSA folder (already resumed or picked) the open map, and read it.
export async function loadFolder(id: string): Promise<void> {
  useStore(fsaStore, { kind: 'folder', id });
  await loadFromDir();
}

// Make the single note (already resumed or picked) the open map, and read it.
export async function loadNote(id: string): Promise<void> {
  useStore(noteStore, { kind: 'note', id });
  await loadFromDir();
}

// Show the open map's name as the path's first folder (:empty hides it until loaded) + the tab title.
export function updateMapTitle(): void {
  paintMapCrumb();
  updateDocumentTitle();
}
// ---------- reload on focus ----------
let reloading = false;
async function reloadFromDisk(): Promise<void> {
  if (!store.isOpen) {
    return;
  }
  // A single refocus dispatches BOTH window 'focus' and 'visibilitychange'. Guard re-entry.
  if (reloading) {
    return;
  }
  // if we just wrote, the focus event is almost certainly our own round-trip — skip
  if (Date.now() - (state.lastSelfWrite || 0) < 600) {
    return;
  }
  // By PATH: ids are minted fresh on every load, so a note added on disk would shift them onto a neighbour.
  const selBefore = state.nodes.get(state.selId ?? '')?.file ?? null;
  // Don't yank the rug out while the user is actively typing in a card or renaming a section.
  if (inPlaceEditActive() || isTypingInField()) {
    return;
  }
  reloading = true;
  try {
    // loadFromDir REPLACES every note with what's on disk, so whatever is still queued must reach the
    // disk first — this used to cancel the pending save instead, and an edit made just before
    // switching away was read over. If a write fails, memory holds the only copy: keep it, don't reload.
    await settleSave();
    if (hasUnsavedChanges()) {
      return;
    }
    if (inPlaceEditActive() || isTypingInField()) {
      return;   // began during the write
    }
    // Nothing changed on disk: keep everything, the undo history included, rather than re-reading it all.
    // Asked last, since asking takes in the new state: a reload skipped above would miss it.
    if (store.changed && !(await store.changed())) {
      return;
    }
    // What was there before, by PATH (ids are minted fresh each load) — and how many unread notes each
    // folded section held — so a note that came in from outside (the phone inbox) can be pointed out.
    const known = new Set<string>(), unread = new Map<string, number>();
    for (const n of state.nodes.values()) {
      if (n.file) {
        known.add(n.file);
        if (n.lazy != null) {
          unread.set(n.file, n.lazy);
        }
      }
    }
    await loadFromDir({ keepView:true });
    selectNode((selBefore && nodeByFile(selBefore)?.id) || null);
    flashArrived([...state.nodes.values()]
      .filter(n => n.file && (!known.has(n.file) || (n.lazy ?? 0) > (unread.get(n.file) ?? n.lazy ?? 0)))
      .map(n => n.id));
  } finally {
    reloading = false;
  }
}
