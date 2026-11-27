// Boot (straight into the last map, no gate) and the home sidebar's list of maps.
import { timeAgo } from './utils/time-ago.js';
import { state, setStatus, type MindNode } from './core/state.js';
import { applyView, frameBox } from './view/camera.js';
import { phoneMode } from './core/ui-state.js';
import { isRoot, descendantCount, subtreeIds } from './utils/model.js';
import { loadFolder, loadNote, switchToDeviceMap, updateMapTitle } from './data/persistence.js';
import { store, currentMap } from './data/active-store.js';
import {
  fsaStore, noteStore, resolveOnDeviceStore, forgetRecent, setOnRecentsChanged,
  readMaps, getLastMap, ensureMapRegistry, createDeviceMap, deleteDeviceMap, renameDeviceMap,
  type MapRef, type MapKind,
} from './store/index.js';
import type { PickResult } from './store/types.js';
import { esc } from './utils/markdown.js';
import { applyUrlFromHash } from './nav/url-state.js';
import { openMenu } from './features/context-menu.js';
import folderIcon from './assets/icons/folder-open.svg?raw';
import documentIcon from './assets/icons/document.svg?raw';
import kebabIcon from './assets/icons/kebab.svg?raw';
import { byId } from './utils/dom.js';
import { settleSave } from './data/save.js';
import { exportZip, openImportPicker } from './data/zip-io.js';
import { loadFromDir } from './data/load.js';

// ?nofsa tests the no-FSA layout on desktop.
const HAS_FSA = !location.search.includes('nofsa') && 'showDirectoryPicker' in window;

async function openDeviceMap(ref: MapRef): Promise<void> {
  await switchToDeviceMap(ref);
  await loadFromDir();
}
// Recents whose stored handle Chrome no longer honours: their next click goes straight to the picker.
const dead = new Set<string>();

// The picker needs a fresh click, and the failed ask may have used it up: then the NEXT click opens it.
async function relink(kind: 'folder' | 'note', key: string): Promise<PickResult> {
  dead.add(key);
  const r = await (kind === 'note' ? noteStore.relink(key) : fsaStore.relink(key));
  if (r === 'ok') {
    dead.delete(key);
  } else if (r === 'needs-click') {
    setStatus(`Corkboard lost its access to that ${kind} — click it again to find it.`);
  } else if (r === 'cancel') {
    setStatus(`Corkboard lost its access to that ${kind}. Click it to find it again, or remove it from the list.`);
  } else if (r === 'denied') {
    setStatus(`Corkboard can’t write to that ${kind}. Open it again and choose “Allow”.`);
  }
  renderMapList();
  return r;
}

// The row click is the gesture for the permission prompt.
async function openFolderMap(key: string): Promise<boolean> {
  await settleSave();   // the old map's pending writes must not land in the new one
  let r = dead.has(key) ? 'gone' : await fsaStore.openRecent(key);
  if (r === 'gone') {
    r = await relink('folder', key);
  } else if (r === 'denied') {
    setStatus('Corkboard can’t write to that folder. Open it again and choose “Allow”.');
  }
  if (r !== 'ok') {
    return false;
  }
  await loadFolder(fsaStore.currentKey!);   // openRecent re-remembers under a fresh key
  return true;
}
async function openNoteMap(key: string): Promise<boolean> {
  await settleSave();
  let r = dead.has(key) ? 'gone' : await noteStore.openRecent(key);
  if (r === 'gone') {
    r = await relink('note', key);
  } else if (r === 'denied') {
    setStatus('Corkboard can’t write to that note. Open it again and choose “Allow”.');
  }
  if (r !== 'ok') {
    return false;
  }
  await loadNote(noteStore.currentKey!);
  return true;
}
export async function pickNote(): Promise<void> {
  await settleSave();
  const r = await noteStore.pick();   // the picker needs this click as its user gesture
  if (r === 'unsupported') { setStatus('This browser can’t open a note in place — use Chrome or Edge.'); return; }
  if (r === 'denied') {
    setStatus('Corkboard can’t write to that note. Open it again and choose “Allow”.');
    return;
  }
  if (r !== 'ok') {
    if (r === 'error' || r === 'gone') {
      setStatus('That note couldn’t be opened. Try choosing it again.');
    }
    return;
  }
  await loadNote(noteStore.currentKey!);
  hideStart();
}
// Opens the dropped file itself, in place. 'needs-click': the drop couldn't ask for write access.
export async function openDropped(handle: FileSystemHandle): Promise<'ok' | 'needs-click' | 'failed'> {
  await settleSave();
  const isNote = handle.kind === 'file';
  const r = isNote ? await noteStore.adopt(handle as FileSystemFileHandle)
    : await fsaStore.adopt(handle as FileSystemDirectoryHandle);
  if (r === 'needs-click') {
    return r;
  }
  if (r === 'gone') {
    setStatus(`That ${isNote ? 'note' : 'folder'} couldn’t be read. Try dropping it again.`);
    return 'failed';
  }
  if (r !== 'ok') {
    setStatus(`Corkboard can’t write to that ${isNote ? 'note' : 'folder'}. Drop it again and choose “Allow”.`);
    return 'failed';
  }
  await (isNote ? loadNote(noteStore.currentKey!) : loadFolder(fsaStore.currentKey!));
  hideStart();
  return 'ok';
}
async function pickFolder(): Promise<void> {
  await settleSave();
  const r = await fsaStore.pick();   // the picker needs this click as its user gesture
  if (r === 'unsupported') { setStatus('This browser can’t open a local folder — use Chrome or Edge.'); return; }
  if (r === 'denied') {
    setStatus('Corkboard can’t write to that folder. Open it again and choose “Allow”.');
    return;
  }
  if (r !== 'ok') {
    if (r === 'error' || r === 'gone') {
      setStatus('That folder couldn’t be opened. Try choosing it again.');
    }
    return;
  }
  await loadFolder(fsaStore.currentKey!);
  hideStart();
}

// Runtime state, not the persisted last-map key: another tab may rewrite that.
function isCurrent(m: MapRef): boolean {
  return !!currentMap && currentMap.id === m.id && currentMap.kind === m.kind && store.isOpen;
}

let renaming: string | null = null;   // map id whose row shows the inline rename input
let naming: string | null = null;     // the one just made, whose first name closes the sidebar
let activeTab: MapKind = 'device';

const NEW_LABEL: Record<MapKind, string> = { device: 'New map', folder: 'Open folder…', note: 'Open a note…' };
const EMPTY_LABEL: Record<MapKind, string> = { device: 'No maps yet.', folder: 'No recent folders yet.', note: 'No recent notes yet.' };

function selectTab(tab: MapKind): void {
  activeTab = tab;
  byId('tabDevice').classList.toggle('active', tab === 'device');
  byId('tabFolder').classList.toggle('active', tab === 'folder');
  byId('tabNote').classList.toggle('active', tab === 'note');
  byId('newBtnLabel').textContent = NEW_LABEL[tab];
  renaming = naming = null;
  renderMapList();
}

function renderMapList(): void {
  const list = readMaps().filter(m => m.kind === activeTab);
  const box = byId('mapList');
  if (!list.length){
    box.innerHTML = `<p class="side-empty">${EMPTY_LABEL[activeTab]}</p>`;
    return;
  }
  box.innerHTML = list.map(m => {
    const name = renaming === m.id
      ? `<input class="mi-name-input" value="${esc(m.name)}" aria-label="Map name">`
      : `<span class="mi-name">${esc(m.name)}</span><span class="mi-when">${timeAgo(m.when)}</span>
         <button class="mi-more" aria-label="Map actions" title="Map actions">${kebabIcon}</button>`;
    return `<div class="map-item${isCurrent(m) ? ' current' : ''}" data-id="${esc(m.id)}" tabindex="0" role="button" aria-label="Open ${esc(m.name)}">
      <span class="mi-icon">${m.kind === 'note' ? documentIcon : folderIcon.replace('btn-icon', '')}</span>${name}</div>`;
  }).join('');

  box.querySelectorAll<HTMLElement>('.map-item').forEach((row, i) => {
    const m = list[i]!;
    row.onclick = e => {
      if ((e.target as HTMLElement).closest('.mi-more, .mi-name-input')) {
        return;
      }
      openRow(m);
    };
    row.onkeydown = e => {
      if (e.key === 'Enter' && e.target === row) {
        openRow(m);
      }
    };
    const more = row.querySelector<HTMLButtonElement>('.mi-more');
    if (more) {
      more.onclick = e => {
        e.stopPropagation();
        const r = more.getBoundingClientRect();
        openMapMenu(m, r.left, r.bottom + 4);
      };
    }
    row.oncontextmenu = e => {
      e.preventDefault(); e.stopPropagation();   // keep the canvas context menu out of it
      openMapMenu(m, e.clientX, e.clientY);
    };
    const inp = row.querySelector<HTMLInputElement>('.mi-name-input');
    if (inp) {
      inp.focus(); inp.select();
      const done = (): void => {
        if (naming === m.id) {
          naming = null;
          hideStart();
        }
      };
      inp.onkeydown = e => {
        if (e.key === 'Enter') {
          inp.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          renaming = null;
          renderMapList();
          done();
        }
      };
      inp.onblur = () => {
        if (renaming !== m.id) {
          return;   // Escape already cancelled
        }
        renaming = null;
        void commitRename(m, inp.value).then(done);
      };
    }
  });
}

function openMapMenu(m: MapRef, x: number, y: number): void {
  const cur = isCurrent(m);
  openMenu([
    ...(m.kind === 'device' ? [{ label: 'Rename', run: () => { renaming = m.id; renderMapList(); } }] : []),
    // Export packs what's loaded on the canvas.
    { label: 'Export .zip', run: () => { exportZip(); }, disabled: !cur },
    'sep',
    m.kind === 'device'
      ? { label: 'Delete…', run: () => { void deleteMap(m); }, danger: true }
      : { label: 'Remove from list', run: () => { void removeRecent(m); }, danger: true },
  ], x, y);
}

async function openRow(m: MapRef): Promise<void> {
  if (isCurrent(m)) { hideStart(); return; }
  if (m.kind === 'device') {
    await openDeviceMap(m);
    hideStart();
  } else if (await (m.kind === 'note' ? openNoteMap(m.id) : openFolderMap(m.id))) {
    hideStart();
  }
}

async function commitRename(m: MapRef, name: string): Promise<void> {
  await renameDeviceMap(await resolveOnDeviceStore(), m.id, name);
  if (isCurrent(m)) {
    updateMapTitle();
  }
  renderMapList();
}

async function removeRecent(m: MapRef): Promise<void> {
  const what = m.kind === 'note' ? 'The note stays on disk.' : 'The folder and its files stay on disk.';
  if (!confirm(`Remove “${m.name}” from this list?\n${what}`)) {
    return;
  }
  await (m.kind === 'note' ? noteStore.forget(m.id) : forgetRecent(m.id));
  renderMapList();
}
async function deleteMap(m: MapRef): Promise<void> {
  if (!confirm(`Delete “${m.name}” and all its notes from this device?\nThis cannot be undone.`)) {
    return;
  }
  const wasCurrent = isCurrent(m);
  if (wasCurrent) {
    await settleSave();
  }
  await deleteDeviceMap(await resolveOnDeviceStore(), m.id);
  if (wasCurrent) {
    await commitDevice();
  }
  renderMapList();
}

const startScreen = byId('startScreen');
export function showStart(): void {
  renaming = naming = null;
  byId<HTMLButtonElement>('tabFolder').disabled = !HAS_FSA;
  byId<HTMLButtonElement>('tabNote').disabled = !HAS_FSA;
  selectTab(HAS_FSA && currentMap ? currentMap.kind : 'device');
  startScreen.classList.remove('hidden');
  startScreen.inert = false;
}

// Only slid out of sight, so `inert` takes its buttons out of the Tab order.
export function hideStart(): void {
  startScreen.classList.add('hidden');
  startScreen.inert = true;
}

// Opened with its name selected in the sidebar to type over.
export async function newDeviceMap(): Promise<void> {
  showStart();
  selectTab('device');
  const ref = await createDeviceMap(await resolveOnDeviceStore());
  await openDeviceMap(ref);
  renaming = naming = ref.id;
  renderMapList();
}

export function installStartScreen(): void {
  byId('homeBtn').onclick = showStart;
  byId('tabDevice').onclick = () => selectTab('device');
  byId('tabFolder').onclick = () => selectTab('folder');
  byId('tabNote').onclick = () => selectTab('note');

  byId('newBtn').onclick = async () => {
    if (activeTab === 'device'){
      await newDeviceMap();
    } else if (activeTab === 'note') {
      await pickNote();
    } else {
      await pickFolder();
    }
  };
  byId('importBtn').onclick = () => openImportPicker();
  byId('startClose').onclick = () => hideStart();

  startScreen.addEventListener('click', e => {
    if (e.target === startScreen) {
      hideStart();
    }
  });
  setOnRecentsChanged(renderMapList);
  byId('appVersion').textContent = `v${__APP_VERSION__}`;
}

// The last-used on-device map, else the most recent, else a fresh "My map".
async function commitDevice(): Promise<void> {
  const s = await resolveOnDeviceStore();
  const device = readMaps().filter(m => m.kind === 'device');
  const last = getLastMap();
  const ref = (last?.kind === 'device' && device.find(m => m.id === last.id))
    || device[0]
    || await createDeviceMap(s, 'My map');
  await openDeviceMap(ref);
}

// Fitting the whole map on a phone makes cards unreadable: frame the biggest branch, selecting nothing.
function orientForPhone(): void {
  if (!phoneMode() || !state.nodes.size) {
    return;
  }
  let best: MindNode | undefined, bestCount = -1;
  for (const n of state.nodes.values()){
    if (!isRoot(n)) {
      continue;
    }
    const c = descendantCount(n.id);
    if (c > bestCount){ bestCount = c; best = n; }
  }
  if (best) {
    frameBox(subtreeIds(best.id).map(id => state.nodes.get(id)));
  }
}

// What arrives at launch waits for this, so the boot map can't land on top of the one asked for.
let bootDone: () => void = () => {};
export const booted = new Promise<void>(resolve => { bootDone = resolve; });

export async function boot(): Promise<void> {
  try {
    await bootMap();
  } finally {
    bootDone();
  }
}

export function showStartOn(tab: MapKind): void {
  showStart();
  selectTab(HAS_FSA || tab === 'device' ? tab : 'device');
}

async function bootMap(): Promise<void> {
  applyView();
  hideStart();
  if (!readMaps().length) {
    await ensureMapRegistry(await resolveOnDeviceStore());
  }
  // A folder or note resumes only silently (permission still granted).
  const last = getLastMap();
  if (HAS_FSA && last?.kind === 'folder' && await fsaStore.resume(last.id)) {
    await loadFolder(last.id);
  } else if (HAS_FSA && last?.kind === 'note' && await noteStore.resume(last.id)) {
    await loadNote(last.id);
  } else {
    await commitDevice();
  }
  orientForPhone();
  await applyUrlFromHash();
}
