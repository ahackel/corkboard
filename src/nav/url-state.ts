// The URL hash: #/<map-kind>/<map-id>/<node-file-path>?open=&x=&y=&k=&q=
// The path is IDENTITY (a node by its file, never its per-load id); the query is view state, never written
// to a note. Opening or leaving a section pushes history; selection, camera and search only replace it.
import { revealPath } from '../data/lazy.js';
import { state, setStatus } from '../core/state.js';
import { openMapRef } from '../data/persistence.js';
import { store, currentMap } from '../data/active-store.js';
import { readMaps, type MapKind } from '../store/index.js';
import { scopeRootFile } from './scope.js';
import { applyView } from '../view/camera.js';
import { searchQuery, setSearchQuery } from '../features/search.js';
import { nodeLabel, nodeByFile } from '../utils/model.js';
import { restoreScopeFromFile } from './sections.js';
import { selectNode } from '../features/selection.js';

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
}
function encodeFilePath(file: string): string {
  return file.replace(/\.md$/i, '').split('/').map(encodeURIComponent).join('/');
}
function decodeFilePath(encoded: string): string {
  return encoded.split('/').map(decodeURIComponent).join('/') + '.md';
}

function currentDocumentTitle(): string {
  const node = state.selId ? state.nodes.get(state.selId) : undefined;
  return node ? `${nodeLabel(node)} — ${store.name}` : `Corkboard — ${store.name}`;
}
export function updateDocumentTitle(): void {
  document.title = currentDocumentTitle();
}

function buildHash(): string {
  if (!store.isOpen) {
    return '';
  }
  const node = state.selId ? state.nodes.get(state.selId) : undefined;
  // A store with no registry entry keeps a name segment for its own in-tab navigation.
  const parts = currentMap ? [currentMap.kind, encodeURIComponent(currentMap.id)] : [slugify(store.name)];
  if (node?.file) {
    parts.push(encodeFilePath(node.file));
  }
  const params = new URLSearchParams();
  const open = scopeRootFile();
  if (open) {
    params.set('open', encodeFilePath(open));
  }
  params.set('x', Math.round(state.view.x).toString());
  params.set('y', Math.round(state.view.y).toString());
  params.set('k', state.view.k.toFixed(2));
  const q = searchQuery();
  if (q) {
    params.set('q', q);
  }
  return '#/' + parts.join('/') + '?' + params.toString();
}

// Set while applyUrlFromHash runs, so what it selects and pans isn't written straight back out.
let applying = false;
let lastHash: string | null = null;
let replaceTimer: ReturnType<typeof setTimeout> | undefined;

function writeHash(kind: 'push' | 'replace'): void {
  if (applying) {
    return;
  }
  const hash = buildHash();
  if (!hash || hash === lastHash) {
    return;
  }
  lastHash = hash;
  if (kind === 'push') {
    history.pushState(null, '', hash);
  } else {
    history.replaceState(null, '', hash);
  }
}

// A section opened or left: a new history entry.
export function syncUrl(): void {
  writeHash('push');
}

const URL_SYNC_DELAY_MS = 350;

// Selection, camera, search: replaces the current entry.
export function scheduleUrlSync(): void {
  if (applying) {
    return;
  }
  clearTimeout(replaceTimer);
  replaceTimer = setTimeout(() => writeHash('replace'), URL_SYNC_DELAY_MS);
}

// On boot and popstate. A legacy name-based hash works only for the map already open.
export async function applyUrlFromHash(): Promise<void> {
  const hash = location.hash;
  if (!hash || hash.length < 2) {
    return;
  }
  const [pathPart, queryPart = ''] = hash.slice(2).split('?');   // drop the leading '#/'
  const segs = pathPart.split('/').filter(Boolean);
  const [mapPart, mapId, ...rest] = segs;
  if (!mapPart || !store.isOpen) {
    return;
  }

  let pathSegs: string[];
  if ((mapPart === 'device' || mapPart === 'folder' || mapPart === 'note') && mapId) {
    let id: string;
    try { id = decodeURIComponent(mapId); }
    catch { setStatus('That link has an invalid map identifier.'); return; }
    const kind = mapPart as MapKind;
    const ref = readMaps().find(m => m.kind === kind && m.id === id);
    if (!ref) { setStatus('That map is not available on this device.'); return; }
    if (!(await openMapRef(ref))) {
      setStatus(`That local ${kind === 'note' ? 'note' : 'folder'} needs to be opened from Home before this link can restore it.`);
      return;
    }
    pathSegs = rest;
  } else {
    if (slugify(store.name) !== mapPart) {
      return;
    }
    pathSegs = mapId ? [mapId, ...rest] : [];
  }

  applying = true;
  try {
    const params = new URLSearchParams(queryPart);
    // Scope first: isSelectable refuses an out-of-scope id, and a scope restored later would refit the
    // camera. Unread folded sections on the way are read first.
    const open = params.get('open');
    if (open) {
      await revealPath(decodeFilePath(open));
    }
    if (pathSegs.length) {
      await revealPath(decodeFilePath(pathSegs.join('/')));
    }
    restoreScopeFromFile(open ? decodeFilePath(open) : null);
    if (pathSegs.length) {
      const file = decodeFilePath(pathSegs.join('/'));
      const target = nodeByFile(file);
      if (target) {
        selectNode(target.id);
      }
    }
    const x = Number(params.get('x')), y = Number(params.get('y')), k = Number(params.get('k'));
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(k) && k > 0) {
      state.view.x = x; state.view.y = y; state.view.k = k;
      applyView();
    }
    const q = params.get('q');
    if (q) {
      setSearchQuery(q);
    }
  } catch {
    setStatus('That link contains an invalid card path.');
  } finally {
    applying = false;
  }
  lastHash = hash;
}

export function installUrlState(): void {
  window.addEventListener('popstate', () => { void applyUrlFromHash(); });
}
