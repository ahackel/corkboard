// The right-click menu on the canvas, also reused by other UI. Touch browsers synthesize `contextmenu`
// from a long-press, so there is deliberately no long-press handling of our own.
import { state, stage, setStatus, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { screenToWorld, fit } from '../view/camera.js';
import { createNode, centredAt } from './crud.js';
import { pasteFromClipboard, pickImagesAt } from './attachments.js';
import { mutate } from './mutate.js';
import { typedImageBlob } from '../data/images.js';
import { bodyImageAt } from './images.js';
import { syncOpenEditor, editorMenuEntries } from './inline-edit.js';
import { esc, stripImageRef } from '../utils/markdown.js';
import { scope, scopeRootNode } from '../nav/scope.js';
// A two-way import cycle with float-bar.ts, safe because both sides use it only in event handlers.
import { buildCardMenu } from './float-bar.js';
import { deleteSelectedEdge } from './edge-tools.js';
import { nodeLabel } from '../utils/model.js';
import { byId, placeInViewport, keys } from '../utils/dom.js';
import { subChevron } from '../view/icons.js';
import { exitScope, goToScopeDepth } from '../nav/sections.js';
import { selectAll } from './selection.js';

// Each panel is its own fixed island: a submenu inside its parent would be clipped by the parent's scroll.
function mountPanel(p: HTMLDivElement): HTMLDivElement {
  // Takes no focus, so an open card editor keeps its caret and selection for the entry to act on.
  p.addEventListener('pointerdown', (e) => e.preventDefault());
  document.body.appendChild(p);
  return p;
}

const newPanel = (): HTMLDivElement => mountPanel(Object.assign(document.createElement('div'), { className: 'cm-panel' }));
const menu = Object.assign(document.createElement('div'), { className: 'cm-panel', id: 'ctxMenu' });

// panels[0] is the menu, panels[d] the submenu opened from an entry of panels[d - 1].
const panels: HTMLDivElement[] = [menu];
const inMenu = (t: Node): boolean => panels.some(p => p.contains(t));

function closeFrom(d: number): void {
  for (let k = Math.max(1, d); k < panels.length; k++) {
    panels[k].classList.remove('open');
  }
  panels[d - 1]?.querySelector('.cm-open')?.classList.remove('cm-open');
}

function closeMenu(): void {
  closeFrom(1);
  menu.classList.remove('open');
}

const SUB_GAP = 4, SUB_RISE = 8;

function openSub(d: number, item: HTMLElement, entries: MenuEntry[]): void {
  closeFrom(d);
  const p = panels[d] ??= newPanel();
  fill(p, entries, d);
  p.classList.add('open');
  item.classList.add('cm-open');
  const r = item.getBoundingClientRect();
  const fitsRight = r.right + SUB_GAP + p.offsetWidth <= window.innerWidth;
  placeInViewport(p, fitsRight ? r.right + SUB_GAP : r.left - SUB_GAP - p.offsetWidth, r.top - SUB_RISE);
}

// With a submenu open, wait a beat, so a diagonal move into it can cross its neighbours on the way.
const SUBMENU_HOVER_DELAY_MS = 200;
let hoverTimer = 0;

function hover(d: number, act: () => void): void {
  clearTimeout(hoverTimer);
  if (panels[d + 1]?.classList.contains('open')) {
    hoverTimer = window.setTimeout(act, SUBMENU_HOVER_DELAY_MS);
  } else {
    act();
  }
}

interface ItemOpts { disabled?: boolean; danger?: boolean }

function addItem(p: HTMLElement, d: number, label: string, shortcut: string, run: () => void, opts: ItemOpts = {}, sub?: MenuEntry[]): void {
  const b = document.createElement('button');
  b.className = 'cm-item' + (opts.danger ? ' cm-danger' : ''); b.type = 'button';
  const l = document.createElement('span'); l.textContent = label; b.appendChild(l);
  if (sub) {
    b.insertAdjacentHTML('beforeend', subChevron());
  } else if (shortcut) {
    const k = document.createElement('kbd'); k.textContent = keys(shortcut); b.appendChild(k);
  }
  if (opts.disabled) {
    b.disabled = true;
  }
  if (sub) {
    b.addEventListener('pointerenter', () => hover(d, () => openSub(d + 1, b, sub)));
    b.addEventListener('click', () => { clearTimeout(hoverTimer); openSub(d + 1, b, sub); });
  } else {
    b.addEventListener('pointerenter', () => hover(d, () => closeFrom(d + 1)));
    b.addEventListener('click', () => { closeMenu(); run(); });
  }
  p.appendChild(b);
}

// An entry with `sub` opens a submenu instead of running anything.
export type MenuEntry = 'sep' | { label: string; shortcut?: string; run?: () => void; disabled?: boolean; danger?: boolean; sub?: MenuEntry[] };

export function openMenu(entries: MenuEntry[], x: number, y: number): void {
  closeMenu();
  fill(menu, entries, 0);
  if (menu.childElementCount) {
    openMenuAt(x, y);
  }
}

function fill(p: HTMLElement, entries: MenuEntry[], d: number): void {
  p.innerHTML = '';
  for (const e of entries){
    if (e === 'sep') {
      addSep(p);
    } else {
      addItem(p, d, e.label, e.shortcut ?? '', e.run ?? (() => {}), e, e.sub);
    }
  }
  if (p.lastElementChild?.className === 'cm-sep') {
    p.lastElementChild.remove();
  }
}

function addSep(p: HTMLElement): void {
  if (!p.lastElementChild || p.lastElementChild.className === 'cm-sep') {
    return;
  }
  const s = document.createElement('div'); s.className = 'cm-sep'; p.appendChild(s);
}

// The closest a browser gets to "reveal in Finder": neither FSA nor OPFS exposes absolute paths.
export function copyFilePath(n: MindNode): void {
  const path = n.file;
  if (!path) {
    return;
  }
  navigator.clipboard.writeText(path)
    .then(() => setStatus(`Copied “${path}”`))
    .catch(() => setStatus('Couldn’t copy path'));
}

// The file itself stays: a note in a folded (unread) section may still show it, and an undo needs it.
function removeImage(n: MindNode, path: string): void {
  if (!path) {
    return;
  }
  mutate([n.id], () => {
    n.body = stripImageRef(n.body, path);
    n.dirty = true;
    syncOpenEditor(n);
  }, { reflow: 'relayout' });
}

// Browsers only accept PNG ClipboardItems, so anything else is re-encoded first.
async function copyImage(img: HTMLImageElement): Promise<void> {
  try {
    let blob = await (await fetch(img.src)).blob();
    if (blob.type !== 'image/png'){
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d')!.drawImage(bmp, 0, 0);
      blob = await new Promise<Blob>((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus('Image copied');
  } catch { setStatus('Couldn’t copy image'); }
}

// A blob URL shows raw bytes from a null origin, so the image goes in as a data: URL. The tab opens
// synchronously in the click, for pop-up blockers.
function showImageInTab(img: HTMLImageElement): void {
  const w = window.open('', '_blank');
  if (!w){ setStatus('Pop-up blocked'); return; }
  (async () => {
    const blob = typedImageBlob(await (await fetch(img.src)).blob(), img.dataset.path ?? '');
    const dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string); fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
    w.document.write(`<!doctype html><title>${esc(img.alt || img.dataset.path || 'Image')}</title>` +
      `<style>html,body{margin:0;height:100%;background:#111;display:grid;place-items:center}` +
      `img{max-width:100%;max-height:100%}</style><img src="${dataUrl}">`);
    w.document.close();
  })().catch(() => { w.close(); setStatus('Couldn’t open image'); });
}

function openMenuAt(sx: number, sy: number): void {
  menu.classList.add('open');
  placeInViewport(menu, sx, sy);
}

function imageMenuEntries(n: MindNode, img: HTMLImageElement): MenuEntry[] {
  const path = img.dataset.path ?? '';
  const loaded = !!img.src && !img.classList.contains('md-img-missing');
  const entries: MenuEntry[] = [];
  entries.push({ label:'Remove image', run: () => removeImage(n, path), disabled: !path });
  entries.push({ label:'Copy image', run: () => { void copyImage(img); }, disabled: !loaded });
  entries.push({ label:'Show image in new tab', run: () => showImageInTab(img), disabled: !loaded });
  entries.push('sep');
  return entries;
}

function canvasMenuEntries(sx: number, sy: number): MenuEntry[] {
  const entries: MenuEntry[] = [];
  // Where a touch user finds the way out of an open section.
  const open = scopeRootNode();
  if (open){
    entries.push({ label:`Leave “${nodeLabel(open)}”`, shortcut:'⌘↑', run: () => exitScope() });
    if (scope.stack.length > 1) {
      entries.push({ label:'Back to the whole map', run: () => goToScopeDepth(0) });
    }
    entries.push('sep');
  }
  const p = screenToWorld(sx, sy);
  entries.push({ label:'Paste here', shortcut:'⌘V', run: () => { void pasteFromClipboard(sx, sy, null); } });
  entries.push('sep');
  entries.push({ label:'New card', shortcut:'N', run: () => createNode(centredAt(p)) });
  entries.push({ label:'Insert image…', run: () => pickImagesAt(sx, sy, null) });
  entries.push('sep');
  // A touch user has no ⌘A.
  entries.push({ label:'Select all', shortcut:'⌘A', run: () => selectAll(), disabled: !state.nodes.size });
  entries.push({ label:'Fit the map to the screen', shortcut:'F', run: () => fit(), disabled: !state.nodes.size });
  return entries;
}

// The canvas menu again, as iOS Safari's synthesized contextmenu on the canvas is unreliable.
const canvasMenuBtn = byId<HTMLButtonElement>('canvasMenuBtn');

export function installContextMenu(): void {
  mountPanel(menu);
  canvasMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const br = canvasMenuBtn.getBoundingClientRect();
    openMenu(canvasMenuEntries(cx, cy), br.left, br.bottom + 4);
  });
  document.addEventListener('contextmenu', (e: MouseEvent) => {
    const t = e.target as Element | null;
    closeMenu();
    if (!t || !t.closest('#stage')) {
      return;
    }

    // ⇧-right-click keeps the browser's menu in the editor, for spelling suggestions.
    if (ui.bodyEdit && (t === ui.bodyEdit.ta || ui.bodyEdit.ta.contains(t))) {
      if (!e.shiftKey) {
        e.preventDefault();
        openMenu(editorMenuEntries(), e.clientX, e.clientY);
      }
      return;
    }
    if (ui.titleEdit && t.closest('.title.editing')) {
      return;
    }
    e.preventDefault();
    const nodeEl = t.closest('.node[data-id]') as HTMLElement | null;
    const id = nodeEl?.dataset.id;
    const n = id ? state.nodes.get(id) : undefined;
    let entries: MenuEntry[];
    if (t.closest('[data-edge]') && state.selEdges.size) {

      // The press before this already selected the line.
      entries = [{ label: 'Delete', shortcut: '⌫', run: () => { deleteSelectedEdge(); } }];
    } else if (n){
      const img = bodyImageAt(nodeEl!, e.clientX, e.clientY);
      entries = [...(img ? imageMenuEntries(n, img) : []), ...buildCardMenu(n, e.clientX, e.clientY)];
    } else {
      entries = canvasMenuEntries(e.clientX, e.clientY);
    }
    openMenu(entries, e.clientX, e.clientY);
  });

  document.addEventListener('pointerdown', (e) => {
    if (menu.classList.contains('open') && !inMenu(e.target as Node)) {
      closeMenu();
    }
  }, true);

  // Capture phase: Escape must close the menu before the global deselect sees it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')){
      e.preventDefault(); e.stopPropagation(); closeMenu();
    }
  }, true);
  stage.addEventListener('wheel', closeMenu, { passive: true });
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
}
