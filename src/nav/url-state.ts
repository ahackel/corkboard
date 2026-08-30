// ============================================================
// URL hash reflects navigable state: current map + selected node, view mode, camera, the
// search query, and read-only — so browser back/forward, reload, and bookmarks restore the
// same view. Node identity in the hash is the note's FILE PATH (the real, stable identity
// per CLAUDE.md), never the in-memory id, which is re-minted on every load. The map segment
// is checked against the currently open map's name; opening a DIFFERENT map from a link
// isn't wired up yet (that needs boot.ts's map-switching flow) — a later slice.
//
// Shape: #/<map-slug>/<node-file-path>?mode=outline&open=&x=&y=&k=&q=&ro=1
//
// In the WIKI view that path slot holds the PAGE's file instead of the selected node's — there the
// page IS what you're looking at, and the selection isn't even on screen. Deliberately the same slot
// rather than a literal `/wiki/` segment: a note may genuinely live at `wiki/page.md`, and the mode
// is already spelled once in `mode=wiki`. So reading pages walks history exactly the way selecting
// cards does, and the segment always means "the note this view is showing you".
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
import { state } from '../core/state.js';
import { store } from '../data/persistence.js';
import { selectNode, applyReadOnly, restoreScopeFromFile } from '../main.js';
import { scopeRootFile } from './scope.js';
import { applyView } from '../view/camera.js';
import { outlineActive, setOutline } from '../features/outline.js';
import { wikiActive, setWiki, wikiPageNode, showWikiPage } from '../features/wiki.js';
import { searchBox, openSearch, runSearch } from '../features/search.js';
import { nodeLabel } from '../utils/model.js';

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

export function currentDocumentTitle(): string {
  // …the PAGE while the wiki view is up, for the same reason the hash carries it: that's the thing
  // on screen, and it's what a bookmark or a history entry should be named after.
  const node = (wikiActive() ? wikiPageNode() : null) ?? (state.selId ? state.nodes.get(state.selId) : undefined);
  return node ? `${nodeLabel(node)} — ${store.name}` : `Corkboard — ${store.name}`;
}
export function updateDocumentTitle(): void {
  document.title = currentDocumentTitle();
}

function buildHash(): string {
  if (!store.isOpen) return '';
  const node = state.selId ? state.nodes.get(state.selId) : undefined;
  const parts = [slugify(store.name)];
  const identity = wikiActive() ? wikiPageNode()?.file : node?.file;
  if (identity) parts.push(encodeFilePath(identity));
  const params = new URLSearchParams();
  if (outlineActive()) params.set('mode', 'outline');
  else if (wikiActive()) params.set('mode', 'wiki');
  const open = scopeRootFile();
  if (open) params.set('open', encodeFilePath(open));
  // The camera is CANVAS state, so the wiki view leaves it out: there is no canvas on screen to
  // frame, and carrying it would make every page entry differ by whatever pan the board happened to
  // be left at. Leaving the view re-frames on the selection anyway (setWiki → focusNode), so there
  // is nothing here to lose. The outliner keeps them — at desktop width it is a drawer over a
  // still-visible canvas.
  if (!wikiActive()) {
    params.set('x', Math.round(state.view.x).toString());
    params.set('y', Math.round(state.view.y).toString());
    params.set('k', state.view.k.toFixed(2));
  }
  const q = searchBox.value.trim();
  if (q) params.set('q', q);
  if (state.readOnly) params.set('ro', '1');
  return '#/' + parts.join('/') + '?' + params.toString();
}

// Guards the re-entrant writes (selectNode/setOutline/applyView/runSearch/applyReadOnly)
// triggered from WITHIN applyUrlFromHash — without this every hash read would immediately
// write an identical hash straight back out.
let applying = false;
let lastHash: string | null = null;
let replaceTimer: ReturnType<typeof setTimeout> | undefined;

function writeHash(kind: 'push' | 'replace'): void {
  if (applying) return;
  const hash = buildHash();
  if (!hash || hash === lastHash) return;
  lastHash = hash;
  if (kind === 'push') history.pushState(null, '', hash);
  else history.replaceState(null, '', hash);
}

// Node selection changed: a discrete navigation step, pushes a new history entry.
export function syncUrl(): void {
  writeHash('push');
}
// Everything else (mode/camera/search/read-only) — debounced, replaces the current entry
// rather than creating a new back-stop for every drag frame or keystroke.
export function scheduleUrlSync(): void {
  if (applying) return;
  clearTimeout(replaceTimer);
  replaceTimer = setTimeout(() => writeHash('replace'), 350);
}

// Read the current hash and apply everything it encodes: select the node, and restore
// mode/camera/search/read-only. Safe to call on boot and on popstate; the node/map lookup
// is a no-op if the hash is absent, malformed, or points at a map that isn't open — but
// mode/camera/search/read-only still apply as long as SOME hash for the open map is present,
// since those don't depend on a node being named.
export function applyUrlFromHash(): void {
  const hash = location.hash;
  if (!hash || hash.length < 2) return;
  const [pathPart, queryPart = ''] = hash.slice(2).split('?');   // drop the leading '#/'
  const segs = pathPart.split('/').filter(Boolean);
  const [mapSlug, ...pathSegs] = segs;
  if (!mapSlug || !store.isOpen || slugify(store.name) !== mapSlug) return;

  applying = true;
  try {
    const params = new URLSearchParams(queryPart);
    // The SCOPE goes first, ahead of both the selection and the camera. Ahead of the selection
    // because isSelectable refuses an out-of-scope id, so the node has to be validated against the
    // scope it's in; ahead of the camera because restoring the scope would otherwise fit over the
    // pan/zoom the URL explicitly asked for (hence restoreScopeFromFile's own no-camera contract).
    const open = params.get('open');
    restoreScopeFromFile(open ? decodeFilePath(open) : null);
    // The MODE is settled BEFORE the path segment is read, because the mode is what the segment
    // MEANS: the page in the wiki view, the selected card everywhere else. (After the scope, which
    // the wiki view's opening page is derived from.)
    const mode = params.get('mode');
    if (mode === 'outline' && !outlineActive()) setOutline(true, false);
    // Wiki is the one mode a hash can also turn OFF. Back/forward can land on an entry from before
    // the view was ever opened, and staying in it would strand the reader on a page the URL doesn't
    // name. Outline stays one-way on purpose: a phone FORCES it by orientation (features/outline.ts
    // phoneWantsOutline), so letting a URL switch it off would fight that.
    if (mode === 'wiki') { if (!wikiActive()) setWiki(true, false); }
    else if (wikiActive()) setWiki(false, false);
    if (pathSegs.length) {
      const file = decodeFilePath(pathSegs.join('/'));
      if (wikiActive()) showWikiPage(file);
      else {
        const target = [...state.nodes.values()].find(n => n.file === file);
        if (target) selectNode(target.id);
      }
    }
    const x = Number(params.get('x')), y = Number(params.get('y')), k = Number(params.get('k'));
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(k) && k > 0) {
      state.view.x = x; state.view.y = y; state.view.k = k;
      applyView();
    }
    const q = params.get('q');
    if (q) { openSearch(); searchBox.value = q; runSearch(); }
    // read-only is only ever forced ON from a link, never OFF — disabling it has real
    // side effects (reloads from disk, discards in-memory-only collapses) that shouldn't
    // happen silently just because a URL lacks `ro=1`.
    if (params.get('ro') === '1' && !state.readOnly) { state.readOnly = true; applyReadOnly(); }
  } finally {
    applying = false;
  }
  lastHash = hash;
}

window.addEventListener('popstate', applyUrlFromHash);
