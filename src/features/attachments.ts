// Images, text and notes pasted or dropped onto the board. An image is a real file in attachments/;
// the note just gets ![alt](attachments/…).
import { state, setStatus, isImageCard } from '../core/state.js';
import { isLockedEffective, nodeAtTarget, takesDrop } from '../utils/model.js';
import { ui, isTypingInField } from '../core/ui-state.js';
import { store } from '../data/active-store.js';
import { IMAGE_FILE_RE, IMAGE_URL_RE, imageExtFor } from '../utils/image-types.js';
import { screenToWorld, worldAtOrCentre } from '../view/camera.js';
import { relayout } from '../render.js';
import { createNode, createCards, centredAt } from './crud.js';
import { splitPastedList } from '../utils/paste-list.js';
import { splitHeading } from '../utils/frontmatter.js';
import { appendMd, imageMd } from '../utils/markdown.js';
import { autosizeBody, syncOpenEditor } from './inline-edit.js';
import { touch } from './history.js';
import { mutate } from './mutate.js';
import { tryPasteCards, cardsToPayload } from './clipboard.js';
import { isSection, sectionAt } from '../view/layout.js';
import { classMarker } from '../utils/dom.js';
import { IMAGE_W, IMAGE_H } from '../view/geometry.js';
import { selectNode } from './selection.js';
import { scheduleSave } from '../data/save.js';

function imgExt(file: File): string {
  const m = (file.name || '').match(/\.[a-z0-9]+$/i);
  return m ? m[0].toLowerCase() : imageExtFor(file.type);
}

// By NAME too: some file managers drop an .svg with no MIME type.
const isImageFile = (f: File): boolean =>
  !!f && (( !!f.type && f.type.startsWith('image/')) || IMAGE_FILE_RE.test(f.name || ''));

const imageFiles = (src: FileList | File[] | null | undefined): File[] => [...(src || [])].filter(isImageFile);
const addedMsg = (n: number): string => `Added ${n} image${n === 1 ? '' : 's'}`;
const dragHasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

async function storeImage(file: File): Promise<string> {
  const name = 'img-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + imgExt(file);
  const path = 'attachments/' + name;
  await store.write(path, file);

  // Our own write: focus-reload must not react to it.
  state.lastSelfWrite = Date.now();
  return path;
}

// The default box when the image can't be decoded.
async function imageSize(file: File): Promise<{ w: number; h: number }> {
  try {
    const bmp = await createImageBitmap(file);
    const { width: w, height: h } = bmp;
    bmp.close();
    if (w > 0 && h > 0) {
      return { w, h };
    }
  } catch { /* fall through to the <img> decode */ }
  // createImageBitmap refuses an SVG blob; an <img> decodes one and reports its intrinsic size.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = fail; img.src = url; });
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      return { w: img.naturalWidth, h: img.naturalHeight };
    }
  } catch { /* fall through to the default box */ }
  finally { URL.revokeObjectURL(url); }
  return { w: IMAGE_W, h: IMAGE_H };
}

function imageCardSize(size: { w: number; h: number }): { w: number; h: number } {
  const w = Math.min(IMAGE_W, size.w);
  const h = w * (size.h / size.w);
  return { w: Math.round(w), h: Math.round(h) };
}

function altFromFile(f: File): string {
  return (f.name || 'image').replace(/\.[^.]*$/, '').replace(/[/\\]/g, '-').trim() || 'image';
}

async function markdownForImages(files: File[]): Promise<string> {
  const out: string[] = [];
  for (const f of files){
    const path = await storeImage(f);
    out.push(imageMd(altFromFile(f), path));
  }
  return out.join('\n');
}

function canAttach(): boolean {
  if (!store.isOpen){ setStatus('Open a folder to add images'); return false; }
  if (state.singleNote){ setStatus('A single note has no folder to keep images in'); return false; }
  return true;
}

async function appendImagesToNode(id: string, files: FileList | File[]): Promise<void> {
  const imgs = imageFiles(files);
  if (!imgs.length || !canAttach()) {
    return;
  }
  const n = state.nodes.get(id);
  if (!n) {
    return;
  }
  if (isLockedEffective(n)) {
    setStatus('Locked — can’t add images');
    return;
  }
  const md = await markdownForImages(imgs);
  mutate([id], () => {
    n.body = appendMd(n.body, md);
    n.dirty = true;
    syncOpenEditor(n);
  }, { reflow: 'remeasure', status: addedMsg(imgs.length) });
}

async function insertImagesAtCursor(files: FileList | File[]): Promise<void> {
  const imgs = imageFiles(files);
  if (!imgs.length || !canAttach()) {
    return;
  }
  if (!ui.bodyEdit){ return; }
  const n = state.nodes.get(ui.bodyEdit.id);
  if (!n) {
    return;
  }
  const ta = ui.bodyEdit.ta;

  // Merges into the open body-edit's history step.
  touch(n.id);
  const md = await markdownForImages(imgs);
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
  const ins = (s > 0 && v[s-1] !== '\n' ? '\n' : '') + md + '\n';
  ta.value = v.slice(0, s) + ins + v.slice(e);
  ta.selectionStart = ta.selectionEnd = s + ins.length;
  autosizeBody(ta);
  n.body = ta.value; n.dirty = true;
  relayout(); scheduleSave();
  setStatus(addedMsg(imgs.length));
}

const CASCADE_STEP = 24;

async function createImageCards(imgs: File[], sx: number | null, sy: number | null, parent: string | null): Promise<void> {
  if (!imgs.length || !canAttach()) {
    return;
  }
  const p = worldAtOrCentre(sx, sy);
  let i = 0;
  for (const f of imgs){
    const [path, natural] = await Promise.all([storeImage(f), imageSize(f)]);
    const alt = altFromFile(f);
    const { w, h } = imageCardSize(natural);
    createNode({
      x: p.x - w / 2 + i * CASCADE_STEP, y: p.y - h / 2 + i * CASCADE_STEP,
      // UNTITLED: a title would end image mode (isImageCard). The alt still names the file (slugStem).
      parent, title: '', body: imageMd(alt, path),
      color: 'none', w, h, edit: false,
    });
    i++;
  }
  setStatus(addedMsg(imgs.length));
}

// Bound per-textarea in startBodyEdit.
export function onBodyPaste(e: ClipboardEvent): void {
  const imgs = imageFiles(e.clipboardData?.files);
  if (imgs.length){ e.preventDefault(); insertImagesAtCursor(imgs); }
}

// The one attach mechanism every mobile browser supports (iOS has no OS drag-drop, and image paste is flaky).
interface PickTarget { sx: number | null; sy: number | null; parent: string | null }
let pickTarget: PickTarget | null = null;
const filePicker = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true });

export function pickImagesAt(sx: number | null, sy: number | null, parent: string | null): void {
  if (!canAttach()) {
    return;
  }
  pickTarget = { sx, sy, parent };
  filePicker.click();
}

function cardOptsAt(sx: number | null, sy: number | null, parent: string | null):
    { x?: number; y?: number; parent: string | null; edit: false } {
  const pn = parent ? state.nodes.get(parent) : undefined;
  if (pn?.collapsed){ touch(pn.id); pn.collapsed = false; }
  const p = sx != null && sy != null ? screenToWorld(sx, sy) : null;
  return { ...(p ? centredAt(p) : {}), parent, edit: false };
}

// <img> load/error fires cross-origin without CORS headers. A hanging host stays a link.
const PROBE_TIMEOUT_MS = 8000;

function probeImage(url: string): Promise<boolean> {
  return new Promise(res => {
    const im = new Image();
    const done = (ok: boolean) => { clearTimeout(t); res(ok); };
    const t = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    im.onload = () => done(true);
    im.onerror = () => done(false);
    im.src = url;
  });
}

// `sx`/`sy` are the raw screen point: images centre on their own box, not `opts`' text-card offset.
function createCardFromClipboard(imgs: File[], text: string, sx: number | null, sy: number | null, opts: ReturnType<typeof cardOptsAt>): void {
  if (imgs.length){ void createImageCards(imgs, sx, sy, opts.parent); return; }
  // Many image URLs (CDNs) have no extension: pasted as a link, then upgraded if it loads as an image.
  if (/^https?:\/\/\S+$/i.test(text)){
    const isImg = IMAGE_URL_RE.test(text);
    const n = createNode({ ...opts, body: isImg ? `![](${text})` : text });
    if (n) {
      setStatus(isImg ? 'Pasted image link' : 'Pasted link');
    }
    if (n && !isImg) {
      void probeImage(text).then(ok => {
      const cur = state.nodes.get(n.id);
      if (!ok || !cur || cur.body !== text) {
        return;
      }
      mutate([cur.id], () => { cur.body = `![](${text})`; cur.dirty = true; },
        { reflow: 'relayout', status: 'Pasted image link' });
    });
    }
    return;
  }
  // A list is one card per item, in a column whose top-left sits where a single card would have.
  const items = splitPastedList(text);
  if (items){
    const at = opts.x != null && opts.y != null ? { x: opts.x, y: opts.y } : centredAt(worldAtOrCentre());
    createCards(items, at, opts.parent);
    return;
  }
  const { title, body } = splitHeading(text);
  createNode({ ...opts, title, body });
}

// Context-menu Paste. Safari allows the async clipboard API only directly in a user gesture.
export async function pasteFromClipboard(sx: number, sy: number, parent: string | null): Promise<void> {
  const imgs: File[] = []; let text = '';
  try {
    const items = await navigator.clipboard.read();
    for (const it of items){
      const imgType = it.types.find(t => t.startsWith('image/'));
      if (imgType) {
        imgs.push(new File([await it.getType(imgType)], 'pasted' + imageExtFor(imgType), { type: imgType }));
      } else if (it.types.includes('text/plain')) {
        text = await (await it.getType('text/plain')).text();
      }
    }
  } catch {
    try { text = await navigator.clipboard.readText(); }
    catch { setStatus('Clipboard not available'); return; }
  }
  text = text.trim();
  if (!imgs.length && !text){ setStatus('Clipboard is empty'); return; }
  if (text && tryPasteCards(text, { sx, sy, parent })) {
    return;
  }
  createCardFromClipboard(imgs, text, sx, sy, cardOptsAt(sx, sy, parent));
}

// At the document level, so the browser never navigates to a dropped file.
const setImgDropTarget = classMarker('img-drop');

// Text dropped from OTHER apps pastes as cards; a drag begun in this page is text-drag.ts's or clipboard.ts's.
let ownDrag = false;

function isTextDrop(e: DragEvent): boolean {
  const types = e.dataTransfer ? [...e.dataTransfer.types] : [];
  const inField = !!(e.target as HTMLElement).closest?.('input, textarea, [contenteditable]');
  return !ownDrag && !inField && !types.includes('Files') && (types.includes('text/plain') || types.includes('text/uri-list'));
}

export function installAttachments(): void {
  filePicker.style.display = 'none';
  document.body.appendChild(filePicker);
  filePicker.addEventListener('change', () => {
    const files = imageFiles(filePicker.files);

    // So the same file can be picked again.
    filePicker.value = '';
    const req = pickTarget; pickTarget = null;
    if (!req || !files.length) {
      return;
    }
    void createImageCards(files, req.sx, req.sy, req.parent);
  });
  document.addEventListener('paste', (e) => {
    if (isTypingInField()) {
      return;
    }
    const cd = e.clipboardData;
    if (!cd) {
      return;
    }
    const imgs = imageFiles(cd.files);
    const text = cd.getData('text/plain').trim();
    if (!imgs.length && !text) {
      return;
    }
    e.preventDefault();

    // Lands in the section under the pointer, like a drop.
    const mx = ui.lastMouse?.x ?? null, my = ui.lastMouse?.y ?? null;
    const w = mx != null && my != null ? screenToWorld(mx, my) : null;
    const into = w ? sectionAt(w.x, w.y, new Set())?.id ?? null : null;
    if (text && tryPasteCards(text, { sx: mx, sy: my, parent: into })) {
      return;
    }
    createCardFromClipboard(imgs, text, mx, my, cardOptsAt(mx, my, into));
  });
  document.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e)) {
      return;
    }
    e.preventDefault();

    if (state.singleNote){ setImgDropTarget(null); return; }
    const t = e.target as HTMLElement;
    const cardNode = nodeAtTarget(t);
    if (cardNode && isLockedEffective(cardNode)) { setImgDropTarget(null); return; }
    setImgDropTarget(t.closest?.('.body-edit') || cardNode?.el || null);
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget == null) {
      setImgDropTarget(null);
    }
  });
  document.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e)) {
      return;
    }
    e.preventDefault();
    const t = e.target as HTMLElement;
    const onEditor = !!t.closest?.('.body-edit');
    const cardNode = nodeAtTarget(t);
    const cardEl   = cardNode?.el ?? null;
    const cardId   = cardNode?.id ?? null;

    // Dropping onto an image card would end image mode, so drops land beside it instead.
    const cardIsImage = !!cardNode && isImageCard(cardNode);
    const cardIsSection = !!cardNode && isSection(cardNode);
    const cardIsLocked = !!cardNode && isLockedEffective(cardNode);
    setImgDropTarget(null);

    const mds = [...e.dataTransfer!.files].filter(f => /\.md$/i.test(f.name));
    if (mds.length){
      const cards = await Promise.all(mds.map(async f => ({ name: f.name, text: await f.text() })));
      tryPasteCards(cardsToPayload(cards), { sx: e.clientX, sy: e.clientY, parent: (cardIsImage || cardIsLocked) ? null : cardId });
    }
    const imgs = imageFiles(e.dataTransfer!.files);
    if (!imgs.length) {
      return;
    }
    if (onEditor && ui.bodyEdit) {
      await insertImagesAtCursor(imgs);
    } else if (cardEl && cardIsSection && !cardIsLocked) {
      selectNode(cardId);
      await createImageCards(imgs, e.clientX, e.clientY, cardId);
    } else if (cardEl && takesDrop(cardNode)) {
      selectNode(cardId);
      await appendImagesToNode(cardId!, imgs);
    } else if (!cardEl || !cardIsLocked) {
      await createImageCards(imgs, e.clientX, e.clientY, null);
    }
  });
  document.addEventListener('dragstart', () => { ownDrag = true; });
  document.addEventListener('dragend', () => { ownDrag = false; });
  document.addEventListener('dragover', (e) => {
    if (!isTextDrop(e)) {
      return;
    }
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    if (!isTextDrop(e)) {
      return;
    }
    e.preventDefault();
    const dt = e.dataTransfer!;
    const uri = dt.getData('text/uri-list').split('\n').find(l => l.trim() && !l.startsWith('#'));
    const text = (dt.getData('text/plain') || uri || '').trim();
    if (!text) {
      return;
    }
    const w = screenToWorld(e.clientX, e.clientY);
    const into = sectionAt(w.x, w.y, new Set())?.id ?? null;
    if (!tryPasteCards(text, { sx: e.clientX, sy: e.clientY, parent: into })) {
      createCardFromClipboard([], text, e.clientX, e.clientY, cardOptsAt(e.clientX, e.clientY, into));
    }
  });
}
