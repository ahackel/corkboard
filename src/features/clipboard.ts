// Copy/cut/paste and export of cards. Other apps get clean text (a note, or an outline of several); the
// card payload (each file's text after a `<!-- corkboard-card: name -->` marker) is remembered beside it.
import { state, setStatus, singleNoteRefuses, type MindNode } from '../core/state.js';
import { serializeMd, parseMd, fileStem, joinHeading, type ParsedNote } from '../utils/frontmatter.js';
import { nodesOf, outermost, isLockedEffective, subtreeIds, childrenOf, nodeLabel } from '../utils/model.js';
import { outlineText, type OutlineItem } from '../utils/outline.js';
import { esc, mdInline, renderBodyHTML } from '../utils/markdown.js';
import { portableHtml } from '../utils/rich-html.js';
import { portableImageUrl } from '../data/images.js';
import { readJSON, writeJSON } from '../utils/local-json.js';
import { detachParentId } from '../nav/scope.js';
import { holderOf, isSection } from '../view/layout.js';
import { zipBytes, zipBlob } from '../utils/zip.js';
import { mkNode, deleteSelection } from './crud.js';
import { touch } from './history.js';
import { mutate } from './mutate.js';
import { cancelDragRestore } from './drag.js';
import { imageExtractInProgress } from './image-extract.js';
import { cardTextDrag } from './text-drag.js';
import { downloadBlob } from '../utils/download.js';
import { worldAtOrCentre } from '../view/camera.js';
import { readAll, afterReading } from '../data/lazy.js';
import { snapPt } from '../view/geometry.js';
import { pasteShift } from '../utils/placement.js';
import { setSelectionSet, selectedIds } from './selection.js';

const MARK = '<!-- corkboard-card: ';

// The read side accepts the app's former name, for a payload copied from an older build.
const MARK_RE = /^<!-- (?:corkboard|mindmap)-card: (.+?) -->$/gm;
const STARTS_MARK = /^<!-- (?:corkboard|mindmap)-card: /;

// serializeMd emits the parent's on-disk path, meaningless outside this map: point it into the payload instead.
function withParentRef(md: string, parentName: string | null): string {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    return md;
  }
  const fm = m[1].split('\n').filter(l => !l.startsWith('mm_parent:'));
  if (parentName) {
    fm.push(`mm_parent: ${parentName}`);
  }
  return `---\n${fm.join('\n')}\n---\n${m[2]}`;
}

export interface CardFile { name: string; text: string }

// What children's mm_parent points at. Not the title: two cards may share one, or have none.
// A never-saved card has no path yet, so its id stands in.
const payloadName = (n: MindNode): string => n.file ?? `${n.id}.md`;

// The given cards INCLUDING their subtrees, parents before their children.
function filesFor(ids: string[]): CardFile[] {
  const roots = outermost(nodesOf(ids)).map(n => n.id);
  const all = roots.flatMap(id => subtreeIds(id));
  const inPayload = new Set(all);
  return all.map(id => {
    const n = state.nodes.get(id)!;
    const p = n.parent && inPayload.has(n.parent) ? state.nodes.get(n.parent) : null;
    return { name: payloadName(n), text: withParentRef(serializeMd(n), p ? payloadName(p) : null) };
  });
}

function selectionFiles(): CardFile[] { return filesFor(selectedIds()); }

export const cardsToPayload = (files: CardFile[]): string =>
  files.map(f => `${MARK}${f.name} -->\n${f.text}`).join('\n');

const readingOrder = (a: MindNode, b: MindNode): number => a.y - b.y || a.x - b.x;

function outlineItem(n: MindNode): OutlineItem {
  const kids = childrenOf(n.id).sort(readingOrder).map(outlineItem).filter(it => it.text.trim() || it.kids.length);
  return { text: isSection(n) ? nodeLabel(n) : [n.title.trim(), n.body.trim()].filter(Boolean).join('\n'), kids };
}

function plainText(ids: string[]): string {
  const roots = outermost(nodesOf(ids)).sort(readingOrder);
  if (roots.length === 1 && !isSection(roots[0])) {
    return joinHeading(roots[0].title, roots[0].body);
  }
  return outlineText(roots.map(outlineItem).filter(it => it.text.trim() || it.kids.length));
}

const COPIED_KEY = 'corkboard-copied';
interface Copied { text: string; payload: string }
let copied: Copied | null = null;

// The card payload behind `text`, when `text` is what a copy here put on the clipboard; else `text` itself.
function payloadBehind(text: string): string {
  const t = text.trim();
  for (const c of [copied, readJSON<Copied | null>(COPIED_KEY, null)]) {
    if (c && c.text.trim() === t) {
      return c.payload;
    }
  }
  return text;
}

// What a copy of `ids` puts on the clipboard: the text other apps read, and the card payload behind it.
function clipFor(ids: string[]): { count: number; text: string; payload: string } {
  const files = filesFor(ids);
  const payload = cardsToPayload(files);
  return { count: files.length, text: plainText(ids).trim() || payload, payload };
}

function copiedNow(clip: { count: number; text: string; payload: string }, how = ''): void {
  copied = { text: clip.text, payload: clip.payload };
  writeJSON(COPIED_KEY, copied);
  setStatus(`Copied ${clip.count} card${clip.count === 1 ? '' : 's'}${how}`);
}

export async function copySelection(): Promise<boolean> {
  const ids = selectedIds();
  await readAll(ids);
  const clip = clipFor(ids);
  if (!clip.count) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(clip.text);
    copiedNow(clip);
    return true;
  } catch {
    setStatus('Couldn’t copy');
    return false;
  }
}

// Each card's pictures resolve beside its own note.
const cardHtml = (n: MindNode, html: string): Promise<string> => portableHtml(html, src => portableImageUrl(src, n.file));

async function outlineHtml(n: MindNode): Promise<string> {
  const kids = await Promise.all(childrenOf(n.id).sort(readingOrder).map(outlineHtml));
  const nested = kids.filter(Boolean).join('');
  const head = isSection(n)
    ? (nodeLabel(n).trim() ? `<strong>${esc(nodeLabel(n))}</strong>` : '')
    : await cardHtml(n, (n.title.trim() ? `<p><strong>${mdInline(n.title.trim())}</strong></p>` : '') + renderBodyHTML(n.body));
  return head || nested ? `<li>${head}${nested ? `<ul>${nested}</ul>` : ''}</li>` : '';
}

async function formattedHtml(ids: string[]): Promise<string> {
  const roots = outermost(nodesOf(ids)).sort(readingOrder);
  if (roots.length === 1 && !isSection(roots[0])) {
    return cardHtml(roots[0], renderBodyHTML(joinHeading(roots[0].title, roots[0].body)));
  }
  return `<ul>${(await Promise.all(roots.map(outlineHtml))).join('')}</ul>`;
}

// The ClipboardItem is made AT ONCE, its parts promised: Safari only lets a page write the clipboard
// straight from the click or key.
export async function copyFormatted(): Promise<boolean> {
  const ids = selectedIds();
  if (!ids.length) {
    return false;
  }
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    return copySelection();
  }
  const ready = readAll(ids).then(() => clipFor(ids));
  const item = new ClipboardItem({
    'text/plain': ready.then(clip => new Blob([clip.text], { type: 'text/plain' })),
    'text/html': ready.then(() => formattedHtml(ids)).then(html => new Blob([html], { type: 'text/html' })),
  });
  try {
    await navigator.clipboard.write([item]);
    copiedNow(await ready, ' as formatted text');
    return true;
  } catch {
    setStatus('Couldn’t copy');
    return false;
  }
}

// Deletes only once the clipboard write succeeded, so a denied clipboard never destroys cards.
export async function cutSelection(): Promise<void> {
  if (singleNoteRefuses()) {
    return;
  }
  const ids = selectedIds();
  if (!ids.length || !(await copySelection())) {
    return;
  }
  deleteSelection();
  setStatus(`Cut ${ids.length} card${ids.length === 1 ? '' : 's'}`);
}

// False when `pasted` isn't a card payload, so the caller pastes it as text; true when handled.
// So a paste over its source never lands exactly on top of it.
const PASTE_NUDGE = 16;

export function tryPasteCards(pasted: string, at: { sx: number | null; sy: number | null; parent: string | null }): boolean {
  const text = payloadBehind(pasted);
  if (!STARTS_MARK.test(text)) {
    return false;
  }
  if (singleNoteRefuses()) {
    return true;
  }
  const cards: Array<{ name: string; p: ParsedNote }> = [];
  const marks = [...text.matchAll(MARK_RE)];
  for (let i = 0; i < marks.length; i++){
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    cards.push({ name: marks[i][1], p: parseMd(text.slice(start, end).trim()) });
  }
  if (!cards.length) {
    return false;
  }
  const byName = new Map(cards.map(c => [c.name, c]));
  const isPayloadRoot = (c: { p: ParsedNote }): boolean => !c.p.mm.parent || !byName.has(c.p.mm.parent);
  // Snapping the anchor puts the whole group on the grid, keeping its internal spacing.
  const target = snapPt(worldAtOrCentre(at.sx, at.sy));
  const { x: dx, y: dy } = pasteShift(target, cards.filter(isPayloadRoot).map(c => c.p.mm), PASTE_NUDGE);
  const dest = holderOf(at.parent) ?? detachParentId();
  const destNode = dest ? state.nodes.get(dest) : undefined;
  if (destNode && isLockedEffective(destNode)) {
    setStatus('Locked — can’t add a child');
    return true;
  }
  const rootIds: string[] = [];
  mutate([], () => {
    const holder = holderOf(at.parent);
    const parentNode = holder ? state.nodes.get(holder) : undefined;
    if (parentNode?.collapsed){ touch(parentNode.id); parentNode.collapsed = false; }
    const idByPayloadName = new Map<string, string>();
    for (const c of cards){
      const root = isPayloadRoot(c);
      const n = mkNode({
        x: (c.p.mm.x ?? target.x) + dx, y: (c.p.mm.y ?? target.y) + dy,
        title: c.p.title,
        color: c.p.color,
        tags: [...c.p.tags], body: c.p.body, fmEntries: c.p.fmEntries,
        collapsed: c.p.mm.collapsed, type: c.p.mm.type,
      });
      state.nodes.set(n.id, n);
      idByPayloadName.set(c.name, n.id);
      if (root) {
        rootIds.push(n.id);
      }
    }
    for (const c of cards){
      const n = state.nodes.get(idByPayloadName.get(c.name)!) as MindNode;
      n.parent = isPayloadRoot(c) ? (parentNode?.id ?? detachParentId()) : idByPayloadName.get(c.p.mm.parent)!;
    }
  }, { reflow: 'remeasure' });
  setSelectionSet(rootIds);
  return true;
}

// Keeps String.fromCharCode's spread under the engine's argument limit.
const B64_CHUNK = 0x8000;

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(s);
}

const zipName = (files: CardFile[]): string => fileStem(files[0].name) + '.zip';

function exportFile(files: CardFile[]): { mime: string; name: string; bytes: Uint8Array } {
  return files.length === 1
    ? { mime: 'text/markdown', name: fileStem(files[0].name) + '.md', bytes: new TextEncoder().encode(files[0].text) }
    : { mime: 'application/zip', name: zipName(files),
        bytes: zipBytes(files.map(f => ({ name: f.name, data: f.text }))) };
}

// ⌥-drag a card out to the OS as its .md (or a .zip), via Chrome/Edge's one-entry `DownloadURL`. A native
// drag can only begin at gesture start, so ⌥ at dragstart forks it from the pointer-based move (drag.ts).
export function bindCardFileDrag(n: MindNode): void {
  const el = n.el!;
  el.draggable = true;
  el.addEventListener('dragstart', (e: DragEvent) => {
    // A drag of selected note text (text-drag.ts) is let through, first, so a held ⌥ can't export the card.
    if (cardTextDrag(e.target)) {
      return;
    }
    if (!e.altKey || !e.dataTransfer){ e.preventDefault(); return; }
    if (imageExtractInProgress()){ e.preventDefault(); return; }
    cancelDragRestore();
    const ids = state.sel.has(n.id) && state.sel.size > 1 ? [...state.sel] : [n.id];
    const f = exportFile(filesFor(ids));
    e.dataTransfer.effectAllowed = 'copy';
    // ONLY DownloadURL: Chrome ignores it when other formats are set alongside (crbug 55071).
    e.dataTransfer.setData('DownloadURL', `${f.mime}:${f.name}:data:${f.mime};base64,${b64(f.bytes)}`);
  });
}

export function exportSelection(): void {
  if (afterReading(selectedIds(), exportSelection)) {
    return;
  }
  const files = selectionFiles();
  if (!files.length) {
    return;
  }
  const name = zipName(files);
  downloadBlob(zipBlob(files.map(f => ({ name: f.name, data: f.text }))), name);
  setStatus(`Saved ${name}`);
}

// canShare() can say yes where every share() rejects for want of an OS share sheet: on file://, desktop
// Linux, and Chromium on macOS before 128 (crbug.com/1144920).
const ua = navigator.userAgent;
const isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
const isLinux = /Linux/.test(ua) && !/Android/.test(ua) && !/CrOS/.test(ua);
const chromeVersion = Number(ua.match(/Chrome\/(\d+)/)?.[1]);
const isPreFix128MacChrome = isMac && chromeVersion > 0 && chromeVersion < 128;
const noOsShareSurface = isLinux || isPreFix128MacChrome;
const shareFile = new File(['x'], 'x.md', { type: 'text/markdown' });
export const canShareFiles = location.protocol !== 'file:' && !noOsShareSurface
  && typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [shareFile] });

export async function shareSelection(): Promise<void> {
  await readAll(selectedIds());
  const files = selectionFiles();
  if (!files.length) {
    return;
  }
  const f = exportFile(files);
  const file = new File([f.bytes as BlobPart], f.name, { type: f.mime });
  if (!navigator.canShare?.({ files: [file] })){
    console.error('shareSelection: navigator.canShare rejected', file.type, file.name);
    setStatus('Can’t share this as a file');
    return;
  }
  try {
    await navigator.share({ files: [file], title: f.name });
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') {
      return;
    }
    console.error('shareSelection: navigator.share failed', err, { ua: navigator.userAgent, platform: navigator.platform });
    setStatus('Couldn’t share');
  }
}
