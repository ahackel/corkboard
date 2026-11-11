// ---------- in-place card editing ----------
// Editing happens ON the card, not in the sidebar, and a card is ONE text field: its title is the
// leading `# ` line of that text (utils/frontmatter.ts splitHeading), so there is nothing to edit
// separately. Double-click, F2, `E` and the pen all open the SAME raw-markdown textarea and differ
// only in where the caret lands — startInlineEdit puts it on the title, startBodyEdit past it.
// An open ui.bodyEdit defers the file rename / disk-reload while typing so the folder isn't littered
// with half-typed names. Reflow uses the live DOM height. The note itself is written while you PAUSE
// typing and when the tab hides or closes (flushOpenEdit), so a long edit is never only in the textarea.
// Esc and a click away both END the edit, keeping what's there; ⌘Z takes the whole session back.
//
// What the merge deleted, and why none of it is missed: the contenteditable `.title` editor (and with
// it the draggable-ancestor dance that only a contenteditable needed — see setCardDraggable's obituary
// in features/text-drag.ts), and `titleProblem`, which had nothing left to refuse once a title may be
// empty (untitled cards) AND duplicated.
import { state, stage, setStatus, type MindNode } from '../core/state.js';
import { ui, type Pt } from '../core/ui-state.js';
import { isLockedEffective } from '../utils/model.js';
import { cardMarkdown, setNoteText, caretIn, firstTextLine } from '../utils/frontmatter.js';
import { linkPaste } from '../utils/markdown.js';
import { highlightMarkdown } from '../utils/md-highlight.js';
import { htmlToMarkdown } from '../utils/html-md.js';
import { listEnter, listBackspace, renumber, renumbered, pasteTable, sourceOffset, tableEnter, tableTab, headingSection,
         startCompletion, EDIT_COMMANDS, editCommandFor, type TextEdit } from '../utils/md-edit.js';
import { onBodyPaste } from './attachments.js';
import { relayout, remeasure, paintNode } from '../main.js';
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

// The text the editor holds is the note with its title back on the front as a heading — exactly the
// file's own body (utils/frontmatter.ts cardMarkdown), which makes the editor a view of the note rather
// than a form over two fields.

export function syncOpenEditor(n: MindNode): void {
  if (ui.bodyEdit?.id === n.id) {
    ui.bodyEdit.ta.value = ui.bodyEdit.saved = cardMarkdown(n);
    paintHighlight(ui.bodyEdit.ta);
  }
}

// ---------- an open edit is never only in the textarea ----------
// Write what the open editor holds into its note WITHOUT closing it, and queue the save. The card keeps its
// textarea, the filename stays frozen until the edit ends (frozenFileNodeId), and the session is still one
// undo step (its before-image was taken when it opened). True when there was something new to write.
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
// …after a pause in the typing, and AT ONCE when the tab is hidden or closed — the last moments a page
// is sure to get (data/save.ts flushes the rest of the map on the same events).
const IDLE_SAVE_MS = 1500;
let idleSave: number | undefined;
const flushNow = (): void => {
  if (flushOpenEdit()) {
    void flushSave();
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushNow();
  }
});
window.addEventListener('pagehide', flushNow);
window.addEventListener('beforeunload', flushNow);

// ---------- the view follows the caret ----------
// Where the caret's line sits, in the textarea's own CSS px from its top: a hidden copy of the textarea
// laid out with the text up to the caret (the browser reports no caret position for a textarea).
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
  const out = { top: mark.offsetTop, left: mark.offsetLeft, line: mark.offsetHeight || parseFloat(cs.lineHeight) || 20 };
  m.remove();
  return out;
}
// The caret's line on screen, top and bottom.
function caretOnScreen(ta: HTMLTextAreaElement): { top: number; bottom: number } {
  const k = state.view.k || 1, c = caretTop(ta), top = ta.getBoundingClientRect().top + c.top * k;
  return { top, bottom: top + c.line * k };
}
// …and where the caret is on screen, for the list of names under it (features/complete.ts).
function caretPoint(ta: HTMLTextAreaElement): { left: number; bottom: number } {
  const k = state.view.k || 1, c = caretTop(ta), r = ta.getBoundingClientRect();
  return { left: r.left + c.left * k, bottom: r.top + (c.top + c.line) * k };
}
// Offer the map's cards after `[[` and its tags after `#`, if that's what the caret is typing.
function offerNames(ta: HTMLTextAreaElement, n: MindNode): void {
  updateCompletion(ta, n.id, () => caretPoint(ta), r => applyTextEdit(ta, r));
}
// Typing past the edge of the screen PANS the view to keep the caret's line in sight — never zooms: the
// canvas is still the canvas, the camera just walks down the note with you.
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

// A note longer than its card scrolls inside it while edited (main.ts paintNode): keep the caret's line in that box.
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

// The browser scrolls a focused field into view by scrolling its nearest scrollable box — #stage, which is
// `overflow:hidden` and must never scroll (it would shift the canvas under every hit test). followCaret
// does that job with the camera instead.
stage.addEventListener('scroll', () => {
  if (stage.scrollTop || stage.scrollLeft) {
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
  }
});

// ---------- leaving the editor keeps your place ----------
// The rendered note is shorter than its raw markdown, so on a TALL card the line you were editing would
// jump away when the editor closes. Find that line's block in the rendered note — by its text, the
// markdown marks stripped — so the view can be panned to keep it where it was on screen.
const strip = (s: string): string => s
  .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?)/, '')
  .replace(/\]\([^)]*\)/g, '').replace(/[*_`~[\]]/g, '').replace(/\s+/g, ' ').trim();
function renderedBlockFor(bodyEl: HTMLElement, text: string, pos: number): HTMLElement | null {
  const from = text.lastIndexOf('\n', pos - 1) + 1, nl = text.indexOf('\n', pos);
  const line = text.slice(from, nl < 0 ? text.length : nl);
  // in a table row, the cell the caret is in
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
  const want = strip(seg).slice(0, 40) || strip(line).slice(0, 40);
  if (want.length < 2) {
    return null;
  }
  const nth = text.slice(0, from).split('\n').filter(l => strip(l).includes(want)).length;
  const blocks = [...bodyEl.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,pre')]
    .filter(b => (b.textContent ?? '').replace(/\s+/g, ' ').includes(want))
    .filter((b, _i, all) => !all.some(o => o !== b && b.contains(o)));   // the innermost match
  return blocks[Math.min(nth, blocks.length - 1)] ?? null;
}

// ---------- rename (F2 / the ⋯ menu / a fresh card / a double-clicked title row) ----------
// Not its own editor any more: it opens the card's one field with the caret on the TITLE. Kept as the
// single rename FUNNEL, so the lock refusal happens in exactly one place.
// `at`, a click's point on a section's tab, puts the caret there instead of selecting the name.
export function startInlineEdit(n: MindNode | undefined, { isNew = false, at }: { isNew?: boolean; at?: Pt } = {}): void {
  if (!n) {
    return;
  }
  if (isLockedEffective(n)) { setStatus('Locked — can’t rename'); return; }
  // A SECTION's label can't live in the card editor — it's a folder TAB of fixed height, and the section's own
  // `.body` is display:none, so a textarea in there couldn't be focused (see ui-state.ts TitleEdit). Its
  // tab is renamed on itself instead.
  if (n.type === 'section') { startTitleEdit(n, { isNew, at }); return; }
  startCardEdit(n, { caret: 'title', isNew });
}

// ---------- a section's label, renamed in place (on its tab) ----------
// The float bar's title button (T): open the label with its NAME selected — and on an untitled section,
// which shows no label at all, seed one first, so the label comes back with a name ready to type over.
// Esc on a seeded name leaves the section untitled, as it was.
export function editSectionTitle(n: MindNode): void {
  if (isLockedEffective(n)) { setStatus('Locked — can’t rename'); return; }
  startTitleEdit(n, { seed: nextSectionTitle() });
}
function startTitleEdit(n: MindNode, { isNew = false, seed = '', at }: { isNew?: boolean; seed?: string; at?: Pt } = {}): void {
  if (!n.el) {
    return;
  }
  if (ui.bodyEdit) {
    endBodyEdit();                                  // close a card editor first
  }
  if (ui.titleEdit) {
    endTitleEdit();                                // …or any other label editor
  }
  touch(n.id);   // the whole edit session becomes ONE undo step (for a fresh section, incl. its creation)
  if (state.selId !== n.id || state.sel.size !== 1) {
    selectNode(n.id);
  }
  // Scoped to a DIRECT child: nodeEl builds `.title-row > .title` for every kind, a folded section
  // included, and a section's child cards may be DOM-nested inside it — so an unscoped
  // `.title` lookup could pick a child card's title instead of this node's own.
  const titleEl = n.el.querySelector(':scope > .title-row > .title') as HTMLElement;
  // The label is the section's NAME and nothing else (view/layout.ts sectionName), so that is all the
  // editor holds: plain text, one line, no `# ` — endTitleEdit writes it back as the heading.
  const raw = sectionName(n) || seed;
  // A click's point is read off the RENDERED tab, so before the raw text replaces it.
  const clicked = at ? offsetAt([titleEl], raw, 0, at) : null;
  ui.titleEdit = { id:n.id, el:titleEl, isNew };
  setCardDraggable(n, false);
  // The raw text REPLACES the rendered tab, so paintNode's render cache no longer describes what's in
  // the element — clear the key, or a cancelled (or unchanged) edit leaves the editor's plain text sitting
  // in the tab: the next paint sees a matching key and skips the re-render. Same reason startCardEdit
  // clears the body's.
  delete titleEl.dataset.md;
  // An UNNAMED section draws no tab (view/layout.ts sectionLabelled) — reveal the row for the duration, or the
  // editor would open on a display:none element and swallow every keystroke. paintNode keeps it revealed
  // while ui.titleEdit points here, and hides it again after the commit if nothing was typed.
  n.el.classList.remove('no-title');
  titleEl.textContent = raw;
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('editing');
  n.el.classList.add('title-editing');   // what the handles and the ring key on (paintNode keeps it)
  titleEl.focus();
  selectTitle(titleEl, clicked);
}

// The caret at `at` in a label being renamed, or (null) the whole name selected, so typing replaces it.
function selectTitle(titleEl: HTMLElement, at: number | null): void {
  const r = document.createRange();
  if (at != null && titleEl.firstChild) {
    r.setStart(titleEl.firstChild, Math.min(at, titleEl.textContent?.length ?? 0));
  } else {
    r.selectNodeContents(titleEl);
  }
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}

// ALL of the open editor's text selected: the double-click (or double-tap) whose first click opened it
// (main.ts editOnClick), as FigJam's double-click on a sticky does.
export function selectAllInEditor(): void {
  if (ui.bodyEdit) {
    const ta = ui.bodyEdit.ta;
    ta.setSelectionRange(0, ta.value.length);
    paintHighlight(ta);
  } else if (ui.titleEdit) {
    selectTitle(ui.titleEdit.el, null);
  }
}
// A card element is `draggable` (the ⌥ card-file export, features/clipboard.ts), and a draggable
// ANCESTOR is decisive: the browser resolves any drag begun inside it as that ELEMENT's drag, so a
// mouse can't select text inside a contenteditable while it holds. (A <textarea> is the exception — a
// text control with a selection outranks the ancestor — which is why the CARD editor needs none of
// this.) Every teardown path puts it back; exporting a section mid-rename isn't a gesture anyone is making.
function setCardDraggable(n: MindNode | undefined, on: boolean): void {
  if (n?.el) {
    n.el.draggable = on;
  }
}
// Live: reflow as the label grows. n.title is untouched (layout uses the live DOM), so a half-typed
// name can't corrupt anything — and there is nothing to VALIDATE any more (empty and duplicate are
// both legal), which is what took the old `.invalid` outline away.
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
  // Enter finishes, ⇧Enter too: a name is one line, and a label shows nothing else.
  if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); e.stopPropagation(); endTitleEdit(); }
  else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); endTitleEdit({ cancel:true }); }
}
// Commit (or cancel) a section rename. The text is the NAME, written back as the note's `# ` heading — and an
// EMPTY commit is accepted: a section may have no name, in which case it shows no label at all (main.ts
// sectionLabelled), like an untitled FigJam section. The label hangs outside the box, so neither moves
// the box. The toolbar's title button (features/float-bar.ts) brings a label back.
// Nothing restores the element's text here: `ui.titleEdit` is nulled first, which lets the paintAll below
// re-render the tab from the fields — the raw source goes away with the editor.
export function endTitleEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const te = ui.titleEdit;
  if (!te) {
    return;
  }
  ui.titleEdit = null;                                // null first → the blur handler becomes a no-op
  const n = state.nodes.get(te.id);
  // One line: a pasted line break folds to a space.
  const val = (te.el.innerText ?? te.el.textContent ?? '').replace(/\s+/g, ' ').trim();
  setCardDraggable(n, true);
  te.el.removeAttribute('contenteditable');
  te.el.classList.remove('editing');
  n?.el?.classList.remove('title-editing');
  te.el.blur();                                       // ensure the keyboard closes on iOS
  if (!n) { commitStep(); return; }
  if (cancel && te.isNew){                            // Esc on a freshly-created section = cancel creation
    discardNewCard(n.id, 'Cancelled new card');
    return;
  }
  if (!cancel) {
    // A note written without a heading showed its first line as the name, so that line IS what was edited.
    if (!n.title.trim()) {
      const lines = n.body.split('\n');
      lines.splice(Math.max(0, firstTextLine(lines)), 1);
      n.body = lines.join('\n').trim();
    }
    n.title = val;
  }
  n.dirty = true;
  remeasure();             // the label may have changed width → reflow
  scheduleSave();
  commitStep();                                       // one undo step per rename session
}
// Commit whichever in-place editor is open. The ONE call every "something else is happening now" path
// uses — a canvas tap, an undo, a drag, a scope change — so none of them has to know which of the two
// sessions it might be closing.
export function endInPlaceEdit(): void { endBodyEdit(); endTitleEdit(); }

// ---------- the card's ONE editor ----------
// Shows the RAW markdown of the whole note — title heading included — in a textarea inside `.body`,
// with the rendered `.title-row` hidden for the duration (styles.css `.node.card-editing`), since the
// title is in the textarea and showing it twice would read as two fields. Enter inserts a newline
// (continuing a list item — utils/md-edit.ts has the writing helpers); Esc and blur both commit.
export function autosizeBody(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';
  paintHighlight(ta);
}

// The syntax highlight laid BEHIND the card editor's transparent text (styles.css `.body-hl`). Repainted
// with every size check, since every path that changes the text — typing, the editor's own helpers, an
// image paste — already ends in one.
function paintHighlight(ta: HTMLTextAreaElement): void {
  const hl = ta.nextElementSibling as HTMLElement | null;
  if (hl?.classList.contains('body-hl')) {
    hl.innerHTML = highlightMarkdown(ta.value, ta.selectionEnd) + '\n';
    hl.style.top = ta.offsetTop + 'px';
  }
}
// Paste a URL over selected text and the text becomes a LINK — or, if it already is one, keeps its
// label and takes the new URL (utils/markdown.ts linkPaste owns that rule). Bound by the card's editor.
// It writes nothing but the textarea and then dispatches `input`, so the editor's own live path runs
// (the card's reflow) without needing to know this happened.
// Returns whether it handled the event, so an image paste still gets its turn.
function pasteUrlLink(e: ClipboardEvent, ta: HTMLTextAreaElement): boolean {
  const r = linkPaste(ta.value, ta.selectionStart, ta.selectionEnd, e.clipboardData?.getData('text/plain') ?? '');
  if (!r) {
    return false;
  }
  e.preventDefault();
  applyTextEdit(ta, r);
  return true;
}
// The ONE way the editor's own helpers (link paste, list Enter, Tab, ⌘B…) write into the textarea:
// replace only the span that CHANGED, through the browser's own insert, so it lands on the textarea's
// native undo stack — assigning `ta.value` wipes that stack, and ⌘Z in the editor would then undo
// nothing. `execCommand` is deprecated but still the only call that does this in Chrome and Safari;
// where it's refused, `setRangeText` writes the same span (without undo) and we raise the `input`
// the browser would have, so the editor's live path (autosize, reflow) runs either way.
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
// Where the caret lands: on the card's NAME (selected, so typing replaces it — the old rename's
// select-all) or at the end. 'title' on an untitled card lands at the top and types a heading for you,
// which is the one nudge that keeps F2 meaningful there.
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
    return;          // already editing this card
  }
  if (ui.bodyEdit) {
    endBodyEdit();                              // close any other open editor
  }
  if (ui.titleEdit) {
    endTitleEdit();                            // …including a section's label
  }
  touch(n.id);   // the whole edit session becomes ONE undo step (for a fresh card, incl. its creation)
  if (state.selId !== n.id || state.sel.size !== 1) {
    selectNode(n.id);
  }
  const bodyEl = n.el.querySelector('.body') as HTMLElement;
  const ta = document.createElement('textarea');
  // The editor opens on the note EXACTLY as it is — a rename of an untitled card used to seed a bare
  // `# ` for the name to be typed into, and no longer does: putting a marker in a note nobody asked to
  // name writes markdown the user didn't type, and it had to be swept up again at commit when they
  // didn't want it. F2 on an untitled card puts the caret at the very start instead (caretIn), which is
  // where a `# ` would go if that's what they meant.
  const text = cardMarkdown(n);
  // A click's point is read off the RENDERED note, so it has to be read before the textarea replaces it.
  // From the very start, title included: a card's heading is drawn in its `.body` like the rest.
  const clicked = typeof caret === 'object' ? offsetAt([bodyEl], text, 0, caret) : null;
  ta.className = 'body-edit'; ta.spellcheck = true; ta.value = text;
  // `isNew` marks a just-created card: Escape then cancels the whole creation (deletes it), rather
  // than just reverting the edit the way it does for an existing card.
  ta.rows = 1;   // a textarea's default is 2 rows: a one-line card would grow a line just by opening
  ui.bodyEdit = { id:n.id, orig:text, saved:text, el:bodyEl, ta, isNew, holdH: n.el.getBoundingClientRect().height / (state.view.k || 1) };
  n.el.classList.remove('no-body');                            // give the body slot room while editing
  // The textarea REPLACES the rendered note, so the render cache paintNode keys `.body` on is no longer
  // describing what's in there — clear it, or committing an edit that changed nothing would leave the
  // textarea sitting in the card (the guarded re-render would see a matching key and skip).
  delete bodyEl.dataset.md;
  const hl = document.createElement('pre');
  hl.className = 'body-hl'; hl.setAttribute('aria-hidden', 'true');
  ta.classList.add('with-hl');   // its own text goes transparent over the highlight (styles.css)
  bodyEl.innerHTML = ''; bodyEl.append(ta, hl);   // the textarea stays first: .body's first-child spacing is its
  bodyEl.classList.add('editing');
  // typing: keep the textarea sized to its content and reflow siblings as the card grows/shrinks
  let lineCount = text.split('\n').length;
  ta.addEventListener('input', (e) => {
    // A line deleted, cut or pasted into a numbered list renumbers it (md-edit.ts renumber) — only when
    // the LINE COUNT changed, so fixing a digit by hand isn't fought over keystroke by keystroke.
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
  // moving the caret by keyboard walks the view along too
  ta.addEventListener('keyup', (e) => {
    if (/^(Arrow|Page|Home|End)/.test(e.key)) {
      paintHighlight(ta);              // the focus follows the caret
      followCaret(ta);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        offerNames(ta, n);
      }
    }
  });
  // A triple-click on a HEADING selects its whole section (md-edit.ts headingSection) — ready to drag out
  // as a card of its own, or ⌘⇧E. Anywhere else it is the browser's own line select.
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
    // (Dragging this card's edge takes the focus too, but the editor stays open: features/resize.ts gives it back.)
    if (ui.bodyEdit && ui.bodyEdit.id === n.id && ui.resizingId !== n.id) {
      endBodyEdit();
    }
  });
  // a URL over a selection links it; anything else falls through to the image paste / the native insert
  ta.addEventListener('paste',   (e) => {
    if (!pasteSheet(e, ta) && !pasteUrlLink(e, ta) && !pasteRich(e, ta)) {
      onBodyPaste(e);
    }
  });
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());   // place the caret, don't drag the card
  ta.focus({ preventScroll: true });   // the camera, not a scroll of #stage, brings the caret into view
  autosizeBody(ta);              // size to content first so the card's real height is known…
  relayout();    // …then reflow siblings around it (not just after a newline)
  const [from, to] = clicked != null ? [clicked, clicked]
    : caret === 'all' ? [0, text.length]
    : caretIn(text, caret === 'title' ? 'title' : 'end');
  ta.setSelectionRange(from, to);
  scrollCaretIntoCard(ta);
  paintHighlight(ta);            // the focus starts where the caret landed
}
// Rich text copied from a web page, Google Docs, Word… pastes as markdown (utils/html-md.ts), keeping its links,
// bold, lists and tables; ⌘⇧V (the system's "paste as plain text") pastes the plain text, as it always did.
// A picture on the clipboard is left to the image paste (features/attachments.ts), which saves the file.
let plainUntil = 0;
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
// Cells copied from a spreadsheet paste as a markdown table (md-edit.ts pasteTable).
function pasteSheet(e: ClipboardEvent, ta: HTMLTextAreaElement): boolean {
  const r = pasteTable(ta.value, ta.selectionStart, ta.selectionEnd, e.clipboardData?.getData('text/plain') ?? '');
  if (!r) {
    return false;
  }
  e.preventDefault();
  applyTextEdit(ta, r);
  return true;
}
// Where in the SOURCE a point on rendered text is: the text node under the point and the offset into
// it (the browser's own hit test), mapped through md-edit.ts sourceOffset, reading the source from
// `from`. `roots` are the rendered elements, in source order. Null for a miss (an image, a gap), leaving
// the caret where the caller puts it by default.
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

// "Edit the note" — the same one editor, caret past the name rather than on it. Kept as its own name
// because that's what its callers mean (a click on the selected card, a double-click, `E`, the pen). A
// click passes its point, and the caret lands on the letter it hit; a double-click passes 'all'.
export function startBodyEdit(n: MindNode, at?: Pt | 'all'): void {
  startCardEdit(n, { caret: at ?? 'end' });
}
// Drop the editor WITHOUT reading the textarea back, because the caller (crud.ts cutBodyRange) has
// already written the shortened n.body and endBodyEdit would commit the textarea's pre-cut value
// straight over it. The textarea element itself goes with the next paintNode, which re-renders .body
// once no editor claims this card.
export function dropBodyEdit(): void {
  const be = ui.bodyEdit;
  if (!be) {
    return;
  }
  ui.bodyEdit = null;
  closeCompletion();
  be.el.classList.remove('editing');
}
// Live, as the user types: only this card's height and the lines meeting it can change (nothing flows),
// so only they repaint — not the whole map per keystroke. n.body isn't touched here, so an in-progress
// edit can't corrupt anything — the textarea content is preserved by paintNode.
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
  e.stopPropagation();                                  // keep canvas/card shortcuts out while typing
  if (e.isComposing) {
    return;                            // an IME owns Enter/Tab while it composes
  }
  if (completionKey(e)) {
    return;                            // ↑↓, Enter, Tab and Esc are the list's while it's up
  }
  const ta = ui.bodyEdit.ta, mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && e.shiftKey && k === 'v') {
    plainUntil = Date.now() + 1000;     // the paste this starts is a plain one (pasteRich)
  }
  const edit = (r: TextEdit | null): void => { if (r){ e.preventDefault(); applyTextEdit(ta, r); } };
  // Esc is "done", like a click away — never "throw it away": a stray Esc must not cost a long edit, and
  // ⌘Z takes the whole session back. Only a FRESH card nobody typed into is cancelled (endBodyEdit).
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
  // A plain Enter in a table adds a row, in a list item starts the next one (an empty one ends either);
  // anywhere else it falls through and the textarea inserts a newline (notes are multi-line). ⇧Enter is
  // always a bare newline — the way to write a second paragraph inside an item.
  else if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
    const [v, a, b] = [ta.value, ta.selectionStart, ta.selectionEnd];
    edit(tableEnter(v, a, b) ?? renumbered(listEnter(v, a, b)));
  }
  // Backspace just past a list marker takes the marker (a nested item steps out first).
  else if (e.key === 'Backspace' && !mod && !e.altKey && !e.shiftKey) {
    edit(renumbered(listBackspace(ta.value, ta.selectionStart, ta.selectionEnd)));
  }
  // ⌘B / ⌘I / ⌘⇧X wrap, ⌘L makes tasks, Tab / ⇧Tab nest (in a table: walk the cells — and never move focus,
  // which would blur the card shut), ⌥↑ / ⌥↓ move lines: md-edit.ts EDIT_COMMANDS, the list the
  // right-click menu shows too.
  else {
    const cmd = editCommandFor(e);
    if (cmd) {
      edit(cmd.edit(ta.value, ta.selectionStart, ta.selectionEnd));
    }
  }
}
// ---------- the editor's right-click menu ----------
// Every command the editor knows, with its key, where the caret is (features/context-menu.ts opens it on a
// right-click inside the card's text). The menu takes no focus (its pointerdown is held), so the textarea
// keeps its caret and selection and each entry acts on them, exactly as its key would. ⇧-right-click
// still gets the browser's own menu, for spelling suggestions.
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
    return { label: label(id, c.label), shortcut: c.shortcut, run: () => run(c.edit(ta.value, ta.selectionStart, ta.selectionEnd)) };
  };
  const complete = (mark: '[[' | '#'): void => {
    run(startCompletion(ta.value, ta.selectionStart, ta.selectionEnd, mark));
    if (n) {
      offerNames(ta, n);
    }
  };
  return [
    { label: 'Cut', shortcut: '⌘X', run: () => { document.execCommand('cut'); }, disabled: !picked },
    { label: 'Copy', shortcut: '⌘C', run: () => { document.execCommand('copy'); }, disabled: !picked },
    { label: 'Paste', shortcut: '⌘V', run: () => { void pasteClipboard(ta, false); } },
    { label: 'Paste as plain text', shortcut: '⌘⇧V', run: () => { void pasteClipboard(ta, true); } },
    'sep',
    command('bold'), command('italic'), command('strike'),
    { label: 'Link to a card…', shortcut: '[[', run: () => complete('[[') },
    { label: 'Tag…', shortcut: '#', run: () => complete('#') },
    'sep',
    command('task'), command('indent'), command('outdent'), command('up'), command('down'),
    'sep',
    { label: 'Selection to a new card', shortcut: '⌘⇧E', run: () => extractToCard(), disabled: !picked },
    { label: 'Done', shortcut: '⌘↩', run: () => endBodyEdit() },
    'sep',
    { label: 'Spelling suggestions', shortcut: '⇧ right-click', run: () => {}, disabled: true },
  ];
}
// The menu's Paste: what a ⌘V would paste, read off the clipboard and handed to the editor's own paste path
// as a paste event, so a URL over a selection still links, a sheet still becomes a table and rich text still
// becomes markdown (each handler reads only `clipboardData`). Nobody taking it inserts the plain text. Plain
// skips all that. The browser may ask for permission to read the clipboard the first time.
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
// Commit (or cancel) the edit. Commit SPLITS the textarea back into the card's title and note
// (splitHeading — the leading `# ` line is the name, everything else the body, and no heading means
// the card is untitled); cancel puts back what the note held when the edit opened (a mid-edit flush may
// already have written past it). Either way we drop the textarea and re-render.
export function endBodyEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const be = ui.bodyEdit;
  if (!be) {
    return;
  }
  ui.bodyEdit = null;                                   // null first → the blur handler becomes a no-op
  closeCompletion();
  clearTimeout(idleSave);
  const editH = state.nodes.get(be.id)?.el?.offsetHeight ?? 0;   // read before anything repaints the card
  // A card taller than the screen is a document you are IN: remember where the caret's line is on screen,
  // so the same line can be put back there once the note renders (below).
  const keepPlace = !cancel && editH * (state.view.k || 1) > stageSize().height
    ? { y: caretOnScreen(be.ta).top, text: be.ta.value, pos: be.ta.selectionEnd } : null;
  be.ta.blur();                                         // ensure keyboard closes on iOS when ended by keypress
  const n = state.nodes.get(be.id);
  be.el.classList.remove('editing');
  if (!n) { commitStep(); return; }
  // An EMPTY card is allowed: clicking away from a fresh one you never typed into keeps it, a blank
  // sticky. It reads as "No-title N" in a list (nodeLabel) and stays blank across a reload, which is what
  // serializeMd's `mm_blank` is for. Only Escape on a fresh, still-empty card cancels the creation.
  if (be.isNew && cancel && !be.ta.value.trim()){
    discardNewCard(n.id);
    return;
  }
  // …and one with text in it is KEPT, whichever way the edit ends: Esc on a fresh card is "done
  // typing", not "throw this away" (capture costs nothing — docs/PRODUCT.md). ⌘Z still removes it.
  if (be.isNew) {
    cancel = false;
  }
  const text = cancel ? be.orig : be.ta.value;
  const changed = text !== be.orig;
  if (text !== be.saved){
    // No sweeping-up of a bare `# ` first line here either: nothing puts one there but the user now,
    // and deleting what somebody typed is worse than leaving an empty heading in their note.
    setNoteText(n, text);
    n.dirty = true;
  }
  remeasure();               // re-render and reflow the height change

  // Confirming never changes the card's height either: it stays what it was while edited (BodyEdit.holdH).
  // Text now taller than that is CLIPPED (n.clip), text now shorter leaves it standing at that minimum.
  const hold = be.holdH ?? 0;
  const pinned = !n.collapsed && !heightIsDeclared(n) && hold > 0 && Math.abs((n.el?.offsetHeight ?? hold) - hold) > 1;
  if (pinned) {
    n.clip = (n.el?.offsetHeight ?? hold) > hold || undefined;
    n.h = hold;
    n.dirty = true;
    remeasure();
  }
  // The text decides what the bar offers (a card with lines to tuck away can fold): the bar was synced for
  // the text the edit STARTED with, and the card often stays selected after it ends.
  if (changed || pinned || be.saved !== be.orig) { scheduleSave(); syncFloatBar(); }
  if (keepPlace) {
    const block = renderedBlockFor(be.el, keepPlace.text, keepPlace.pos);
    const dy = block ? keepPlace.y - block.getBoundingClientRect().top : 0;
    if (Math.abs(dy) > 1) {
      jumpViewTo(state.view.x, state.view.y + dy);
    }
  }
  commitStep();                                         // no-op sessions (cancel/unchanged) are discarded
}
