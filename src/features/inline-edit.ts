// In-place editing: a card is ONE raw-markdown textarea (its title is the leading `# ` line); a section's
// label is renamed on its tab. Esc and a click away both keep the text; ⌘Z takes the session back.
import { state, stage, setStatus, type MindNode } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { isLockedEffective } from '../utils/model.js';
import { cardMarkdown, setNoteText, caretIn, firstTextLine } from '../utils/frontmatter.js';
import { linkPaste } from '../utils/markdown.js';
import { highlightMarkdown } from '../utils/md-highlight.js';
import { htmlToMarkdown } from '../utils/html-md.js';
import { listEnter, listBackspace, renumber, renumbered, sourceOffset, headingSection,
         startCompletion, EDIT_COMMANDS, editCommandFor } from '../utils/md-edit.js';
import { pasteTable, tableEnter, tableTab } from '../utils/md-table.js';
import type { TextEdit } from '../utils/text-edit.js';
import { onBodyPaste } from './attachments.js';
import { relayout, remeasure, paintNode } from '../render.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { heightIsDeclared } from '../view/geometry.js';
import { sectionName } from '../view/layout.js';
import { extractToCard, discardNewCard, nextSectionTitle } from './crud.js';
import { syncFloatBar } from './float-bar.js';
import { touch, commitStep } from './history.js';
import { selectNode } from './selection.js';
import { scheduleSave, flushSave } from '../data/save.js';
import { updateCompletion, completionKey, closeCompletion } from './complete.js';
import { jumpViewTo, stageSize, bottomInset } from '../view/camera.js';
import type { MenuEntry } from './context-menu.js';

export function syncOpenEditor(n: MindNode): void {
  if (ui.bodyEdit?.id === n.id) {
    ui.bodyEdit.ta.value = ui.bodyEdit.saved = cardMarkdown(n);
    paintHighlight(ui.bodyEdit.ta);
  }
}

// Writes the open editor into its note WITHOUT closing it, so a long edit is never only in the textarea.
// The filename stays frozen until the edit ends. True when there was something new to write.
export function flushOpenEdit(): boolean {
  const be = ui.bodyEdit;
  if (!be || be.ta.value === be.saved) {
    return false;
  }
  const n = state.nodes.get(be.id);
  if (!n) {
    return false;
  }
  setNoteText(n, be.ta.value);
  n.dirty = true;
  be.saved = be.ta.value;
  scheduleSave();
  return true;
}

const IDLE_SAVE_MS = 1500;
let idleSave: number | undefined;
const flushNow = (): void => {
  if (flushOpenEdit()) {
    void flushSave();
  }
};

const FALLBACK_LINE_PX = 20;

// A textarea reports no caret position, so lay out a hidden copy up to the caret and measure it.
function caretTop(ta: HTMLTextAreaElement): { top: number; left: number; line: number } {
  const cs = getComputedStyle(ta), m = document.createElement('div');
  for (const p of ['font', 'letterSpacing', 'lineHeight', 'padding', 'border', 'boxSizing', 'width', 'tabSize',
                   'textIndent', 'textTransform', 'wordSpacing', 'overflowWrap', 'wordBreak'] as const) {
    m.style[p] = cs[p];
  }
  Object.assign(m.style, { position: 'absolute', left: '-99999px', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap' });
  m.textContent = ta.value.slice(0, ta.selectionEnd);
  const mark = m.appendChild(document.createElement('span'));
  mark.textContent = '\u200b';
  document.body.appendChild(m);
  const out = { top: mark.offsetTop, left: mark.offsetLeft, line: mark.offsetHeight || parseFloat(cs.lineHeight) || FALLBACK_LINE_PX };
  m.remove();
  return out;
}

function caretOnScreen(ta: HTMLTextAreaElement): { top: number; bottom: number } {
  const k = state.view.k || 1, c = caretTop(ta), top = ta.getBoundingClientRect().top + c.top * k;
  return { top, bottom: top + c.line * k };
}

function caretPoint(ta: HTMLTextAreaElement): { left: number; bottom: number } {
  const k = state.view.k || 1, c = caretTop(ta), r = ta.getBoundingClientRect();
  return { left: r.left + c.left * k, bottom: r.top + (c.top + c.line) * k };
}

// Cards after `[[`, tags after `#`.
function offerNames(ta: HTMLTextAreaElement, n: MindNode): void {
  updateCompletion(ta, n.id, () => caretPoint(ta), r => applyTextEdit(ta, r));
}

// Pans (never zooms) to keep the caret's line on screen.
const CARET_MARGIN = 56;
let followFrame = 0;

function followCaret(ta: HTMLTextAreaElement): void {
  cancelAnimationFrame(followFrame);
  followFrame = requestAnimationFrame(() => {
    if (!ui.bodyEdit || ui.bodyEdit.ta !== ta) {
      return;
    }
    scrollCaretIntoCard(ta);
    const c = caretOnScreen(ta), top = stage.getBoundingClientRect().top;
    const bottom = top + stageSize().height - bottomInset();
    const dy = c.bottom > bottom - CARET_MARGIN ? bottom - CARET_MARGIN - c.bottom
      : c.top < top + CARET_MARGIN ? top + CARET_MARGIN - c.top : 0;
    if (dy) {
      jumpViewTo(state.view.x, state.view.y + dy);
    }
  });
}

function scrollCaretIntoCard(ta: HTMLTextAreaElement): void {
  const box = ta.parentElement!;
  if (box.scrollHeight <= box.clientHeight) {
    return;
  }
  const c = caretTop(ta), y = ta.offsetTop + c.top;
  if (y < box.scrollTop) {
    box.scrollTop = y;
  } else if (y + c.line > box.scrollTop + box.clientHeight) {
    box.scrollTop = y + c.line - box.clientHeight;
  }
}

const stripMarks = (s: string): string => s
  .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?)/, '')
  .replace(/\]\([^)]*\)/g, '').replace(/[*_`~[\]]/g, '').replace(/\s+/g, ' ').trim();
const MATCH_CHARS = 40;

// The rendered block of the caret's line, matched by its text, so closing a TALL card's editor can keep
// that line where it was on screen.
function renderedBlockFor(bodyEl: HTMLElement, text: string, pos: number): HTMLElement | null {
  const from = text.lastIndexOf('\n', pos - 1) + 1, nl = text.indexOf('\n', pos);
  const line = text.slice(from, nl < 0 ? text.length : nl);
  let seg = line;
  if (line.trim().startsWith('|')) {
    const cells = line.split(/(?<!\\)\|/);
    let at = 0;
    for (const c of cells) {
      if (pos - from <= at + c.length) {
        seg = c;
        break;
      }
      at += c.length + 1;
    }
  }
  const want = stripMarks(seg).slice(0, MATCH_CHARS) || stripMarks(line).slice(0, MATCH_CHARS);
  if (want.length < 2) {
    return null;
  }
  const nth = text.slice(0, from).split('\n').filter(l => stripMarks(l).includes(want)).length;
  const blocks = [...bodyEl.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,pre')]
    .filter(b => (b.textContent ?? '').replace(/\s+/g, ' ').includes(want))
    .filter((b, _i, all) => !all.some(o => o !== b && b.contains(o)));
  return blocks[Math.min(nth, blocks.length - 1)] ?? null;
}

// The single rename funnel (so the lock refusal is in one place). `at`, a click on a section's tab, puts
// the caret there instead of selecting the name.
export function startInlineEdit(n: MindNode | undefined, { isNew = false, at }: { isNew?: boolean; at?: Pt } = {}): void {
  if (!n) {
    return;
  }
  if (isLockedEffective(n)) { setStatus('Locked — can’t rename'); return; }
  // A section's `.body` is display:none, so its tab is renamed on itself.
  if (n.type === 'section') { startTitleEdit(n, { isNew, at }); return; }
  startCardEdit(n, { caret: 'title', isNew });
}

// An untitled section is seeded a name to type over; Esc leaves it untitled.
export function editSectionTitle(n: MindNode): void {
  if (isLockedEffective(n)) { setStatus('Locked — can’t rename'); return; }
  startTitleEdit(n, { seed: nextSectionTitle() });
}

function startTitleEdit(n: MindNode, { isNew = false, seed = '', at }: { isNew?: boolean; seed?: string; at?: Pt } = {}): void {
  if (!n.el) {
    return;
  }
  endInPlaceEdit();
  touch(n.id);
  if (state.selId !== n.id || state.sel.size !== 1) {
    selectNode(n.id);
  }
  // Child cards may be DOM-nested inside, so only this node's OWN title.
  const titleEl = n.el.querySelector(':scope > .title-row > .title') as HTMLElement;
  const raw = sectionName(n) || seed;
  // Read off the RENDERED tab, before the raw text replaces it.
  const clicked = at ? offsetAt([titleEl], raw, 0, at) : null;
  ui.titleEdit = { id:n.id, el:titleEl, isNew };
  setCardDraggable(n, false);
  // Invalidate paintNode's render cache, or an unchanged edit would leave the raw text in the tab.
  delete titleEl.dataset.md;
  // An unnamed section's tab is display:none, which would swallow every keystroke.
  n.el.classList.remove('no-title');
  titleEl.textContent = raw;
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('editing');
  n.el.classList.add('title-editing');
  titleEl.focus();
  selectTitle(titleEl, clicked);
}

// null selects the whole name, so typing replaces it.
function selectTitle(titleEl: HTMLElement, at: number | null): void {
  const r = document.createRange();
  if (at != null && titleEl.firstChild) {
    r.setStart(titleEl.firstChild, Math.min(at, titleEl.textContent?.length ?? 0));
  } else {
    r.selectNodeContents(titleEl);
  }
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}

// For the double-click whose first click opened the editor, as FigJam's does.
export function selectAllInEditor(): void {
  if (ui.bodyEdit) {
    const ta = ui.bodyEdit.ta;
    ta.setSelectionRange(0, ta.value.length);
    paintHighlight(ta);
  } else if (ui.titleEdit) {
    selectTitle(ui.titleEdit.el, null);
  }
}

// A `draggable` ancestor stops a mouse selecting text in a contenteditable (a textarea is immune).
function setCardDraggable(n: MindNode | undefined, on: boolean): void {
  if (n?.el) {
    n.el.draggable = on;
  }
}

// n.title is untouched until the commit; layout reads the live DOM.
export function onTitleInput(n: MindNode): void {
  if (!ui.titleEdit || ui.titleEdit.id !== n.id) {
    return;
  }
  relayout();
}

export function onTitleKeydown(e: KeyboardEvent, n: MindNode): void {
  if (!ui.titleEdit || ui.titleEdit.id !== n.id) {
    return;
  }
  // ⇧Enter finishes too: a name is one line.
  if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); e.stopPropagation(); endTitleEdit(); }
  else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); endTitleEdit({ cancel:true }); }
}

// An EMPTY name is accepted: the section then shows no label. The repaint restores the tab's text.
export function endTitleEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const te = ui.titleEdit;
  if (!te) {
    return;
  }
  ui.titleEdit = null;                                // null first → the blur handler becomes a no-op
  const n = state.nodes.get(te.id);
  const val = (te.el.innerText ?? te.el.textContent ?? '').replace(/\s+/g, ' ').trim();
  setCardDraggable(n, true);
  te.el.removeAttribute('contenteditable');
  te.el.classList.remove('editing');
  n?.el?.classList.remove('title-editing');
  te.el.blur();                                       // ensure the keyboard closes on iOS
  if (!n) { commitStep(); return; }
  if (cancel && te.isNew){
    discardNewCard(n.id, 'Cancelled new card');
    return;
  }
  if (!cancel) {
    // Without a heading the first line was shown as the name, so that line IS what was edited.
    if (!n.title.trim()) {
      const lines = n.body.split('\n');
      lines.splice(Math.max(0, firstTextLine(lines)), 1);
      n.body = lines.join('\n').trim();
    }
    n.title = val;
  }
  n.dirty = true;
  remeasure();
  scheduleSave();
  commitStep();
}

// What every "something else is happening now" path calls, whichever editor is open.
export function endInPlaceEdit(): void { endBodyEdit(); endTitleEdit(); }

export function autosizeBody(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
  paintHighlight(ta);
}

// Laid BEHIND the textarea's transparent text; every path that changes the text ends in autosizeBody.
function paintHighlight(ta: HTMLTextAreaElement): void {
  const hl = ta.nextElementSibling as HTMLElement | null;
  if (hl?.classList.contains('body-hl')) {
    hl.innerHTML = highlightMarkdown(ta.value, ta.selectionEnd) + '\n';
    hl.style.top = ta.offsetTop + 'px';
  }
}

// A URL pasted over selected text makes it a link. False leaves the paste to the next handler.
function pasteUrlLink(e: ClipboardEvent, ta: HTMLTextAreaElement): boolean {
  const r = linkPaste(ta.value, ta.selectionStart, ta.selectionEnd, e.clipboardData?.getData('text/plain') ?? '');
  if (!r) {
    return false;
  }
  e.preventDefault();
  applyTextEdit(ta, r);
  return true;
}

// The ONE way the editor's helpers write: only the changed span, via execCommand so it lands on the native
// undo stack (assigning `ta.value` wipes it). Where refused, setRangeText plus a synthetic `input`.
function applyTextEdit(ta: HTMLTextAreaElement, r: TextEdit): void {
  const a = ta.value, b = r.text;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) {
    p++;
  }
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) {
    q++;
  }
  const ins = b.slice(p, b.length - q);
  if (a !== b){
    ta.setSelectionRange(p, a.length - q);
    const done = ins ? document.execCommand('insertText', false, ins) : document.execCommand('delete');
    if (!done || ta.value !== b){
      ta.value = a;                                     // undo a half-applied command before the fallback
      ta.setRangeText(ins, p, a.length - q);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  ta.setSelectionRange(r.start, r.end);
}

// 'title' selects the name (on an untitled card: the very start); a Pt is a click's point.
type Caret = 'title' | 'end' | 'all' | Pt;

function startCardEdit(n: MindNode, { caret = 'end', isNew = false }: { caret?: Caret; isNew?: boolean } = {}): void {
  if (!n) {
    return;
  }
  if (isLockedEffective(n)) { setStatus('Locked — can’t edit'); return; }
  if (!n.el) {
    return;
  }
  if (ui.bodyEdit && ui.bodyEdit.id === n.id) {
    return;
  }
  endInPlaceEdit();
  touch(n.id);
  if (state.selId !== n.id || state.sel.size !== 1) {
    selectNode(n.id);
  }
  const bodyEl = n.el.querySelector('.body') as HTMLElement;
  const ta = document.createElement('textarea');
  const text = cardMarkdown(n);
  // Read off the RENDERED note, before the textarea replaces it.
  const clicked = typeof caret === 'object' ? offsetAt([bodyEl], text, 0, caret) : null;
  ta.className = 'body-edit'; ta.spellcheck = true; ta.value = text;
  ta.rows = 1;   // the default 2 would grow a one-line card just by opening
  ui.bodyEdit = { id:n.id, orig:text, saved:text, el:bodyEl, ta, isNew, holdH: n.el.getBoundingClientRect().height / (state.view.k || 1) };
  n.el.classList.remove('no-body');
  // Invalidate paintNode's render cache, or an unchanged edit would leave the textarea in the card.
  delete bodyEl.dataset.md;
  const hl = document.createElement('pre');
  hl.className = 'body-hl'; hl.setAttribute('aria-hidden', 'true');
  ta.classList.add('with-hl');
  bodyEl.innerHTML = ''; bodyEl.append(ta, hl);   // the textarea stays first: .body's first-child spacing is its
  bodyEl.classList.add('editing');
  let lineCount = text.split('\n').length;
  ta.addEventListener('input', (e) => {
    // Renumber lists only when the LINE COUNT changed, so a digit fixed by hand isn't fought over.
    const lines = ta.value.split('\n').length, kind = (e as InputEvent).inputType ?? '';
    if (lines !== lineCount && (kind.startsWith('delete') || kind.startsWith('insertFrom'))) {
      const r = renumber({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd });
      if (r.text !== ta.value) {
        applyTextEdit(ta, r);
      }
    }
    lineCount = ta.value.split('\n').length;
    autosizeBody(ta); onBodyInput(n);
    followCaret(ta);
    offerNames(ta, n);
    clearTimeout(idleSave);
    idleSave = window.setTimeout(flushOpenEdit, IDLE_SAVE_MS);
  });
  ta.addEventListener('keyup', (e) => {
    if (/^(Arrow|Page|Home|End)/.test(e.key)) {
      paintHighlight(ta);
      followCaret(ta);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        offerNames(ta, n);
      }
    }
  });
  // A triple-click on a HEADING selects its whole section.
  ta.addEventListener('click', (e) => {
    const r = e.detail === 3 ? headingSection(ta.value, ta.selectionStart) : null;
    if (r) {
      ta.setSelectionRange(r.start, r.end);
    }
    paintHighlight(ta);
    offerNames(ta, n);
  });
  ta.addEventListener('keydown', (e) => onBodyKeydown(e, n));
  ta.addEventListener('blur',    () => {
    // A resize takes the focus too, and gives it back.
    if (ui.bodyEdit && ui.bodyEdit.id === n.id && ui.resizingId !== n.id) {
      endBodyEdit();
    }
  });
  ta.addEventListener('paste',   (e) => {
    if (!pasteSheet(e, ta) && !pasteUrlLink(e, ta) && !pasteRich(e, ta)) {
      onBodyPaste(e);
    }
  });
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  ta.focus({ preventScroll: true });   // the camera, not a scroll of #stage, brings the caret into view
  autosizeBody(ta);
  relayout();
  const [from, to] = clicked != null ? [clicked, clicked]
    : caret === 'all' ? [0, text.length]
    : caretIn(text, caret === 'title' ? 'title' : 'end');
  ta.setSelectionRange(from, to);
  scrollCaretIntoCard(ta);
  paintHighlight(ta);
}

// ⌘⇧V's keydown opens this window, marking the paste that follows as plain.
const PLAIN_PASTE_WINDOW_MS = 1000;
let plainUntil = 0;

// Rich text pastes as markdown; a picture is left to the image paste.
function pasteRich(e: ClipboardEvent, ta: HTMLTextAreaElement): boolean {
  const plain = Date.now() < plainUntil;
  plainUntil = 0;
  const dt = e.clipboardData;
  if (plain || !dt || [...dt.files].some(f => f.type.startsWith('image/'))) {
    return false;
  }
  const md = htmlToMarkdown(dt.getData('text/html'));
  if (!md) {
    return false;
  }
  e.preventDefault();
  const [v, a, b] = [ta.value, ta.selectionStart, ta.selectionEnd];
  applyTextEdit(ta, { text: v.slice(0, a) + md + v.slice(b), start: a + md.length, end: a + md.length });
  return true;
}

function pasteSheet(e: ClipboardEvent, ta: HTMLTextAreaElement): boolean {
  const r = pasteTable(ta.value, ta.selectionStart, ta.selectionEnd, e.clipboardData?.getData('text/plain') ?? '');
  if (!r) {
    return false;
  }
  e.preventDefault();
  applyTextEdit(ta, r);
  return true;
}

// Where in the SOURCE a point on rendered text is; `roots` in source order. Null for a miss.
function offsetAt(roots: HTMLElement[], source: string, from: number, at: Pt): number | null {
  const d = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  let node: Node | null = null, off = 0;
  const p = typeof d.caretPositionFromPoint === 'function' ? d.caretPositionFromPoint(at.x, at.y) : null;
  if (p) { node = p.offsetNode; off = p.offset; }
  else { const r = d.caretRangeFromPoint?.(at.x, at.y); if (r) { node = r.startContainer; off = r.startOffset; } }
  if (!node || node.nodeType !== Node.TEXT_NODE || !roots.some(r => r.contains(node))) {
    return null;
  }
  const texts: string[] = [];
  let hit = -1;
  for (const root of roots) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t && hit < 0; t = w.nextNode()) {
      if (t === node) {
        hit = texts.length;
      }
      texts.push(t.textContent ?? '');
    }
  }
  return hit < 0 ? null : sourceOffset(source, from, texts, hit, off);
}

export function startBodyEdit(n: MindNode, at?: Pt | 'all'): void {
  startCardEdit(n, { caret: at ?? 'end' });
}

// WITHOUT reading the textarea back: the caller has already written n.body. The next paintNode removes it.
export function dropBodyEdit(): void {
  const be = ui.bodyEdit;
  if (!be) {
    return;
  }
  ui.bodyEdit = null;
  closeCompletion();
  be.el.classList.remove('editing');
}

// Only this card and its lines can change while typing, so not the whole map per keystroke.
function onBodyInput(n: MindNode): void {
  if (!ui.bodyEdit || ui.bodyEdit.id !== n.id) {
    return;
  }
  paintNode(n);
  paintFreeEdges();
}

function onBodyKeydown(e: KeyboardEvent, n: MindNode): void {
  if (!ui.bodyEdit || ui.bodyEdit.id !== n.id) {
    return;
  }
  e.stopPropagation();
  if (e.isComposing) {
    return;
  }
  if (completionKey(e)) {
    return;
  }
  const ta = ui.bodyEdit.ta, mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && e.shiftKey && k === 'v') {
    plainUntil = Date.now() + PLAIN_PASTE_WINDOW_MS;
  }
  const edit = (r: TextEdit | null): void => { if (r){ e.preventDefault(); applyTextEdit(ta, r); } };
  // Esc is "done", never "throw it away": a stray Esc must not cost a long edit.
  if (e.key === 'Escape') {
    e.preventDefault();
    endBodyEdit({ cancel: !!ui.bodyEdit.isNew });
  } else if (mod && e.key === 'Enter') {
    e.preventDefault();
    endBodyEdit();
  } else if (mod && e.shiftKey && k === 'e') {
    e.preventDefault();
    extractToCard();
  }
  // ⇧Enter is always a bare newline: a second paragraph inside a list item.
  else if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
    const [v, a, b] = [ta.value, ta.selectionStart, ta.selectionEnd];
    edit(tableEnter(v, a, b) ?? renumbered(listEnter(v, a, b)));
  }
  else if (e.key === 'Backspace' && !mod && !e.altKey && !e.shiftKey) {
    edit(renumbered(listBackspace(ta.value, ta.selectionStart, ta.selectionEnd)));
  }
  else {
    const cmd = editCommandFor(e);
    if (cmd) {
      edit(cmd.edit(ta.value, ta.selectionStart, ta.selectionEnd));
    }
  }
}

// The menu takes no focus, so each entry acts on the textarea's selection exactly as its key would.
export function editorMenuEntries(): MenuEntry[] {
  const be = ui.bodyEdit;
  if (!be) {
    return [];
  }
  const ta = be.ta, n = state.nodes.get(be.id);
  const [v, a, b] = [ta.value, ta.selectionStart, ta.selectionEnd], picked = a !== b;
  const run = (r: TextEdit | null): void => {
    if (r) {
      applyTextEdit(ta, r);
    }
  };
  const inTable = !!tableTab(v, a, b, false);
  const label = (id: string, l: string): string =>
    inTable && id === 'indent' ? 'Next cell' : inTable && id === 'outdent' ? 'Previous cell' : l;
  const command = (id: string): MenuEntry => {
    const c = EDIT_COMMANDS.find(x => x.id === id)!;
    return { label: label(id, c.label), shortcut: c.shortcut, disabled: !c.edit(v, a, b),
             run: () => run(c.edit(ta.value, ta.selectionStart, ta.selectionEnd)) };
  };
  const commands = (...ids: string[]): MenuEntry[] => ids.map(id => id === 'sep' ? 'sep' : command(id));
  const complete = (mark: '[[' | '#'): void => {
    run(startCompletion(ta.value, ta.selectionStart, ta.selectionEnd, mark));
    if (n) {
      offerNames(ta, n);
    }
  };
  const format: MenuEntry[] = [
    { label: 'Heading', sub: commands('h1', 'h2', 'h3', 'h4', 'h5', 'h6') },
    { label: 'List', sub: commands('bullet', 'number', 'task') },
    ...commands('quote', 'body', 'sep', 'bold', 'italic', 'strike', 'highlight', 'sep', 'code', 'codeblock', 'sep', 'table', 'sep', 'link'),
    { label: 'Link to a card…', shortcut: '[[', run: () => complete('[[') },
    { label: 'Tag…', shortcut: '#', run: () => complete('#') },
    ...commands('sep', 'rule', 'sep', 'clear'),
  ];
  const table = commands('table-sortAsc', 'table-sortDesc', 'sep', 'table-rowAbove', 'table-rowBelow', 'sep',
    'table-colBefore', 'table-colAfter', 'sep', 'table-alignLeft', 'table-alignCenter', 'table-alignRight', 'sep',
    'table-deleteCol', 'table-deleteRow', 'sep', 'table-colLeft', 'table-colRight', 'table-rowUp', 'table-rowDown', 'sep',
    'table-reformat', 'table-transpose');
  return [
    { label: 'Cut', shortcut: '⌘X', run: () => { document.execCommand('cut'); }, disabled: !picked },
    { label: 'Copy', shortcut: '⌘C', run: () => { document.execCommand('copy'); }, disabled: !picked },
    { label: 'Paste', shortcut: '⌘V', run: () => { void pasteClipboard(ta, false); } },
    { label: 'Paste as plain text', shortcut: '⌘⇧V', run: () => { void pasteClipboard(ta, true); } },
    'sep',
    { label: 'Format', sub: format },
    ...(inTable ? [{ label: 'Edit table', sub: table }] : []),
    'sep',
    ...commands('indent', 'outdent', 'up', 'down'),
    'sep',
    { label: 'Selection to a new card', shortcut: '⌘⇧E', run: () => extractToCard(), disabled: !picked },
    { label: 'Done', shortcut: '⌘↩', run: () => endBodyEdit() },
    'sep',
    { label: 'Spelling suggestions', shortcut: '⇧ right-click', run: () => {}, disabled: true },
  ];
}

// Replays the clipboard as a synthetic paste event through the editor's own handlers; if none takes it,
// the plain text is inserted.
async function pasteClipboard(ta: HTMLTextAreaElement, plain: boolean): Promise<void> {
  const still = (): boolean => ui.bodyEdit?.ta === ta;
  try {
    const dt = new DataTransfer();
    if (!plain && navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type.startsWith('image/')) {
            dt.items.add(new File([blob], 'pasted.' + type.slice(6), { type }));
          } else if (type.startsWith('text/')) {
            dt.setData(type, await blob.text());
          }
        }
      }
    } else {
      dt.setData('text/plain', await navigator.clipboard.readText());
    }
    if (!still()) {
      return;
    }
    if (plain || ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))) {
      const text = dt.getData('text/plain'), [v, a, b] = [ta.value, ta.selectionStart, ta.selectionEnd];
      applyTextEdit(ta, { text: v.slice(0, a) + text + v.slice(b), start: a + text.length, end: a + text.length });
    }
  } catch {
    setStatus('Couldn’t read the clipboard — use ⌘V');
  }
}

// Cancel restores the note as it was when the edit opened (a mid-edit flush may have written past it).
export function endBodyEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const be = ui.bodyEdit;
  if (!be) {
    return;
  }
  ui.bodyEdit = null;                                   // null first → the blur handler becomes a no-op
  closeCompletion();
  clearTimeout(idleSave);
  const editH = state.nodes.get(be.id)?.el?.offsetHeight ?? 0;   // read before anything repaints the card
  // A card taller than the screen keeps the caret's line where it is on screen.
  const keepPlace = !cancel && editH * (state.view.k || 1) > stageSize().height
    ? { y: caretOnScreen(be.ta).top, text: be.ta.value, pos: be.ta.selectionEnd } : null;
  be.ta.blur();                                         // ensure keyboard closes on iOS when ended by keypress
  const n = state.nodes.get(be.id);
  be.el.classList.remove('editing');
  if (!n) { commitStep(); return; }
  // Only Esc on a fresh, still-empty card cancels it; a click away keeps a blank sticky.
  if (be.isNew && cancel && !be.ta.value.trim()){
    discardNewCard(n.id);
    return;
  }
  if (be.isNew) {
    cancel = false;
  }
  const text = cancel ? be.orig : be.ta.value;
  const changed = text !== be.orig;
  if (text !== be.saved){
    setNoteText(n, text);
    n.dirty = true;
  }
  remeasure();

  // Committing keeps the height it had while edited: taller text is clipped, shorter leaves a minimum.
  const hold = be.holdH ?? 0;
  const pinned = !n.collapsed && !heightIsDeclared(n) && hold > 0 && Math.abs((n.el?.offsetHeight ?? hold) - hold) > 1;
  if (pinned) {
    n.clip = (n.el?.offsetHeight ?? hold) > hold || undefined;
    n.h = hold;
    n.dirty = true;
    remeasure();
  }
  // What the bar offers (e.g. fold) depends on the text.
  if (changed || pinned || be.saved !== be.orig) { scheduleSave(); syncFloatBar(); }
  if (keepPlace) {
    const block = renderedBlockFor(be.el, keepPlace.text, keepPlace.pos);
    const dy = block ? keepPlace.y - block.getBoundingClientRect().top : 0;
    if (Math.abs(dy) > 1) {
      jumpViewTo(state.view.x, state.view.y + dy);
    }
  }
  commitStep();
}

export function installInlineEdit(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushNow();
    }
  });
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', flushNow);

  // The browser scrolls a focused field into view by scrolling #stage, which would shift every hit test.
  stage.addEventListener('scroll', () => {
    if (stage.scrollTop || stage.scrollLeft) {
      stage.scrollTop = 0;
      stage.scrollLeft = 0;
    }
  });
}
