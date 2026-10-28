// ============================================================
// URL hash reflects navigable state: current map + selected node, view mode, camera, the
// search query, and read-only — so browser back/forward, reload, and bookmarks restore the
// same view. Node identity in the hash is the note's FILE PATH (the real, stable identity
// per CLAUDE.md), never the in-memory id, which is re-minted on every load. Registry-backed
// maps use their stable kind/id pair, so a bookmark can switch away from the currently open map.
//
// Shape: #/<map-kind>/<map-id>/<node-file-path>?mode=outline&open=&x=&y=&k=&q=&ro=1
//
// `open` is the frame you're standing INSIDE (nav/scope.ts) — query string, not path, because it's
// navigable VIEW state like mode=outline rather than identity. Only the INNERMOST level is carried;
// the crumb path above it is rebuilt from the tree (openPathTo), so there's nothing to keep in sync.
// The path carries IDENTITY (which map, which node); the query string carries VIEW STATE
// (mode/camera/search/read-only) — all of it ephemeral: none of these fields are ever
// written back to a note's frontmatter, they only ever flow FROM state INTO the URL.
//
// Selecting a different node pushes a new history entry (it's the primary unit of
// back/forward navigation); mode/camera/search/read-only changes replace the current entry
// instead (scheduleUrlSync, debounced) — they tag along with wherever you last navigated
// rather than creating their own back-stops.
// ============================================================
import { revealPath } from '../data/lazy.js';
import { state, setStatus } from '../core/state.js';
import { store, currentMap, openMapRef } from '../data/persistence.js';
import { readMaps, type MapKind } from '../store/index.js';
import { scopeRootFile } from './scope.js';
import { applyView } from '../view/camera.js';
import { searchQuery, setSearchQuery } from '../features/search.js';
import { nodeLabel, nodeByFile } from '../utils/model.js';
import { restoreScopeFromFile } from './frames.js';
import { selectNode } from '../features/selection.js';
import { applyReadOnly } from '../features/read-only.js';

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
}
// Node identity: the note's relative file path, percent-encoded per path segment so it
// round-trips through a URL hash regardless of what characters are in the title/filename.
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
  if (state.readOnly) {
    params.set('ro', '1');
  }
  return '#/' + parts.join('/') + '?' + params.toString();
}

// Guards the re-entrant writes (selectNode/setOutline/applyView/runSearch/applyReadOnly)
// triggered from WITHIN applyUrlFromHash — without this every hash read would immediately
// write an identical hash straight back out.
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

// Node selection changed: a discrete navigation step, pushes a new history entry.
export function syncUrl(): void {
  writeHash('push');
}
// Everything else (mode/camera/search/read-only) — debounced, replaces the current entry
// rather than creating a new back-stop for every drag frame or keystroke.
export function scheduleUrlSync(): void {
  if (applying) {
    return;
  }
  clearTimeout(replaceTimer);
  replaceTimer = setTimeout(() => writeHash('replace'), 350);
}

// Read the current hash and apply everything it encodes: select the node, and restore
// mode/camera/search/read-only. Safe to call on boot and on popstate; registry-backed hashes
// switch to their map first, while legacy name-based hashes work only for the map already open.
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
  if ((mapPart === 'device' || mapPart === 'folder') && mapId) {
    let id: string;
    try { id = decodeURIComponent(mapId); }
    catch { setStatus('That link has an invalid map identifier.'); return; }
    const kind = mapPart as MapKind;
    const ref = readMaps().find(m => m.kind === kind && m.id === id);
    if (!ref) { setStatus('That map is not available on this device.'); return; }
    if (!(await openMapRef(ref))) {
      setStatus('That local folder needs to be opened from Home before this link can restore it.');
      return;
    }
    pathSegs = rest;
  } else {
    // Backward compatibility for pre-ID hashes: restore only when their named map is already open.
    if (slugify(store.name) !== mapPart) {
      return;
    }
    pathSegs = mapId ? [mapId, ...rest] : [];
  }

  applying = true;
  try {
    const params = new URLSearchParams(queryPart);
    // The SCOPE goes first, ahead of both the selection and the camera. Ahead of the selection
    // because isSelectable refuses an out-of-scope id, so the node has to be validated against the
    // scope it's in; ahead of the camera because restoring the scope would otherwise fit over the
    // pan/zoom the URL explicitly asked for (hence restoreScopeFromFile's own no-camera contract).
    const open = params.get('open');
    // A link may point INTO a folded frame whose notes haven't been read (data/lazy.ts): read the
    // folders on the way first, so there is a node there to stand in or select.
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
    // read-only is only ever forced ON from a link, never OFF — disabling it has real
    // side effects (reloads from disk, discards in-memory-only collapses) that shouldn't
    // happen silently just because a URL lacks `ro=1`.
    if (params.get('ro') === '1' && !state.readOnly) { state.readOnly = true; applyReadOnly(); }
  } catch {
    setStatus('That link contains an invalid card path.');
  } finally {
    applying = false;
  }
  lastHash = hash;
}

window.addEventListener('popstate', () => { void applyUrlFromHash(); });
