// Switching which map is open, and the reload when its folder changed underneath us.
import { state } from '../core/state.js';
import { fsaStore, noteStore, resolveOnDeviceStore, setLastMap, touchMap, type Store, type MapKind, type MapRef } from '../store/index.js';
import { store, currentMap, setActiveStore } from './active-store.js';
import { dataHooks } from './hooks.js';
import { isTypingInField, inPlaceEditActive } from '../core/ui-state.js';
import { settleSave, hasUnsavedChanges } from './save.js';
import { loadFromDir } from './load.js';
import { nodeByFile } from '../utils/model.js';

// `ref`: the registry entry (what boot() reopens); omitted for stores that aren't registry-backed.
export function useStore(s: Store, ref?: { kind: MapKind; id: string }): void {
  setActiveStore(s, ref ?? null);
  s.watch(reloadFromDisk);
  state.singleNote = !!s.singleNote;
  document.body.classList.toggle('single-note', state.singleNote);
  if (ref) { setLastMap(ref.kind, ref.id); touchMap(ref.id); }
}

export async function switchToDeviceMap(ref: MapRef): Promise<void> {
  await settleSave();   // first: a straggling autosave would write the old map into the new one
  const s = await resolveOnDeviceStore();
  s.openMap(ref.id, ref.name);
  await s.pick();
  useStore(s, { kind: 'device', id: ref.id });
}

// For URL/history restoration: a folder or note opens only if its permission resumes silently.
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

// Already resumed or picked.
export async function loadFolder(id: string): Promise<void> {
  useStore(fsaStore, { kind: 'folder', id });
  await loadFromDir();
}

export async function loadNote(id: string): Promise<void> {
  useStore(noteStore, { kind: 'note', id });
  await loadFromDir();
}

export function updateMapTitle(): void {
  dataHooks.showMapName();
}

const RELOAD_RETRY_MS = 1000, OWN_WRITE_ECHO_MS = 600;
let reloading = false;
let reloadLater: number | undefined;

// A deferred reload is still owed, not dropped: a card saved meanwhile could replace a file it hasn't read.
function retryReload(): void {
  clearTimeout(reloadLater);
  reloadLater = window.setTimeout(() => { void reloadFromDisk(); }, RELOAD_RETRY_MS);
}

async function reloadFromDisk(): Promise<void> {
  clearTimeout(reloadLater);
  if (!store.isOpen) {
    return;
  }
  // One refocus fires both 'focus' and 'visibilitychange'.
  if (reloading) {
    return;
  }
  // Just after our own write, the event is most likely its echo.
  if (Date.now() - (state.lastSelfWrite || 0) < OWN_WRITE_ECHO_MS) {
    retryReload();
    return;
  }
  // By PATH: ids are re-minted every load.
  const selBefore = state.nodes.get(state.selId ?? '')?.file ?? null;
  if (inPlaceEditActive() || isTypingInField()) {
    retryReload();
    return;
  }
  reloading = true;
  try {
    // The load replaces every note, so queued edits reach disk first; if a write failed, memory holds
    // the only copy and there is no reload.
    await settleSave();
    if (hasUnsavedChanges()) {
      return;
    }
    if (inPlaceEditActive() || isTypingInField()) {
      retryReload();
      return;
    }
    // Keeps the undo history when nothing changed. Asked last: asking consumes the change.
    if (store.changed && !(await store.changed())) {
      return;
    }
    // So a note that came in from outside (the phone inbox) can be pointed out.
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
    dataHooks.reloaded((selBefore && nodeByFile(selBefore)?.id) || null, [...state.nodes.values()]
      .filter(n => n.file && (!known.has(n.file) || (n.lazy ?? 0) > (unread.get(n.file) ?? n.lazy ?? 0)))
      .map(n => n.id));
  } finally {
    reloading = false;
  }
}
