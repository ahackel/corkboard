// ---------- in-place card editing ----------
// Editing happens ON the card, not in the sidebar, and a card is ONE text field: its title is the
// leading `# ` line of that text (utils/frontmatter.ts splitHeading), so there is nothing to edit
// separately. Double-click, F2, `E` and the pen all open the SAME raw-markdown textarea and differ
// only in where the caret lands — startInlineEdit puts it on the title, startBodyEdit past it.
// An open ui.bodyEdit defers the file rename / disk-reload while typing so the folder isn't littered
// with half-typed names. Reflow uses the live DOM height, so n.title/body stay untouched mid-edit.
//
// What the merge deleted, and why none of it is missed: the contenteditable `.title` editor (and with
// it the draggable-ancestor dance that only a contenteditable needed — see setCardDraggable's obituary
// in features/text-drag.ts), and `titleProblem`, which had nothing left to refuse once a title may be
// empty (untitled cards) AND duplicated.
import { state, setStatus, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { isLockedEffective } from '../utils/model.js';
import { cardMarkdown, setNoteText, firstTextLine, headingOnLine } from '../utils/frontmatter.js';
import { linkPaste } from '../utils/markdown.js';
import { listEnter, listBackspace, indentLines, toggleWrap, taskLines, moveLines, renumber, renumbered, pasteTable,
         sourceOffset, tableEnter, tableTab, type TextEdit } from '../utils/md-edit.js';
import { onBodyPaste } from './attachments.js';
import { relayout, remeasure, paintNode } from '../main.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { extractToCard, discardNewCard } from './crud.js';
import { growFramesToHold, syncFloatBar } from './float-bar.js';
import { touch, commitStep } from './history.js';
import { selectNode } from './selection.js';
import { scheduleSave } from '../data/save.js';

// The text the editor holds is the note with its title back on the front as a heading — exactly the
// file's own body (utils/frontmatter.ts cardMarkdown), which makes the editor a view of the note rather
// than a form over two fields.

export function syncOpenEditor(n: MindNode): void {
  if (ui.bodyEdit?.id === n.id) {
    ui.bodyEdit.ta.value = cardMarkdown(n);
  }
}

// ---------- rename (F2 / the ⋯ menu / a fresh card / a double-clicked title row) ----------
// Not its own editor any more: it opens the card's one field with the caret on the TITLE. Kept as the
// single rename FUNNEL, so the outline-mode
// hand-off and the lock refusal all still happen in exactly one place.
export function startInlineEdit(n: MindNode | undefined, { isNew = false }: { isNew?: boolean } = {}): void {
  if (state.readOnly || !n) {
    return;
  }
  if (isLockedEffective(n)) { setStatus('Locked — can’t rename'); return; }
  // A FRAME's label can't live in the card editor — it's a folder TAB of fixed height, and the frame's own
  // `.body` is display:none, so a textarea in there couldn't be focused (see ui-state.ts TitleEdit). Its
  // tab is renamed on itself instead.
  if (n.type === 'frame') { startTitleEdit(n, { isNew }); return; }
  startCardEdit(n, { caret: 'title', isNew });
}

// ---------- a frame's label, renamed in place (on its tab) ----------
// The float bar's title button (T): open the label with its NAME selected — and on an untitled frame,
// which shows no label at all, seed one first, so the label comes back with a name ready to type over.
// Esc on a seeded name leaves the frame untitled, as it was.
export function editFrameTitle(n: MindNode): void {
  if (state.readOnly) {
    return;
  }
  if (isLockedEffective(n)) { setStatus('Locked — can’t rename'); return; }
  startTitleEdit(n, { seed: 'Frame' });
}
function startTitleEdit(n: MindNode, { isNew = false, seed = '' }: { isNew?: boolean; seed?: string } = {}): void {
  if (!n.el) {
    return;
  }
  if (ui.bodyEdit) {
    endBodyEdit();                                  // close a card editor first
  }
  if (ui.titleEdit) {
    endTitleEdit();                                // …or any other label editor
  }
  touch(n.id);   // the whole edit session becomes ONE undo step (for a fresh frame, incl. its creation)
  if (state.selId !== n.id || state.sel.size !== 1) {
    selectNode(n.id);
  }
  // Scoped to a DIRECT child: nodeEl builds `.title-row > .title` for every kind, a folded frame
  // included, and a frame's child cards may be DOM-nested inside it — so an unscoped
  // `.title` lookup could pick a child card's title instead of this node's own.
  const titleEl = n.el.querySelector(':scope > .title-row > .title') as HTMLElement;
  // The tab RENDERS markdown, so editing it has to show the SOURCE — swap the rendered HTML for the raw
  // text for the duration. Otherwise the editor would show `Name` where the file says `# Name`, and
  // committing would write the rendered text back and silently strip the heading away.
  const own = cardMarkdown(n);
  const raw = own.trim() ? own : seed ? '# ' + seed : own;
  ui.titleEdit = { id:n.id, el:titleEl, isNew };
  setCardDraggable(n, false);
  // The raw text REPLACES the rendered tab, so paintNode's render cache no longer describes what's in
  // the element — clear the key, or a cancelled (or unchanged) edit leaves the editor's plain text sitting
  // in the tab: the next paint sees a matching key and skips the re-render. Same reason startCardEdit
  // clears the body's.
  delete titleEl.dataset.md;
  // An UNNAMED frame draws no tab (view/layout.ts frameLabelled) — reveal the row for the duration, or the
  // editor would open on a display:none element and swallow every keystroke. paintNode keeps it revealed
  // while ui.titleEdit points here, and hides it again after the commit if nothing was typed.
  n.el.classList.remove('no-title');
  titleEl.textContent = raw;
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('editing');
  titleEl.focus();
  const r = document.createRange(); r.selectNodeContents(titleEl);     // select-all so typing replaces
  // …or just the seeded NAME, past its `# `, so typing over it keeps the heading
  if (raw !== own && titleEl.firstChild) {
    r.setStart(titleEl.firstChild, 2);
  }
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}
// A card element is `draggable` (the ⌥ card-file export, features/clipboard.ts), and a draggable
// ANCESTOR is decisive: the browser resolves any drag begun inside it as that ELEMENT's drag, so a
// mouse can't select text inside a contenteditable while it holds. (A <textarea> is the exception — a
// text control with a selection outranks the ancestor — which is why the CARD editor needs none of
// this.) Every teardown path puts it back; exporting a frame mid-rename isn't a gesture anyone is making.
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
  // Enter finishes; ⇧Enter is a new line — the name is the first line, everything after it the
  // frame's description (main.ts paintNode draws it under the name).
  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab'){ e.preventDefault(); e.stopPropagation(); endTitleEdit(); }
  else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); endTitleEdit({ cancel:true }); }
}
// Commit (or cancel) a frame rename. The text is MARKDOWN, so it splits like any card's — `# Name` is a
// heading on the label with the lines below it the description, `Name` is plain text there — and an
// EMPTY commit is accepted: a frame may have no name, in which case it shows no label at all (main.ts
// frameLabelled), like an untitled FigJam section. The label hangs outside the box, so neither moves
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
  // Line breaks KEPT: `# Name` on the first line, the description below it (view/layout.ts
  // frameDescription). Read while the editor is still `.editing` (white-space:pre-wrap) — innerText
  // follows the CSS, and the tab's own nowrap would fold every line break into a space.
  const val = (te.el.innerText ?? te.el.textContent ?? '').replace(/\r\n?/g, '\n').trim();
  setCardDraggable(n, true);
  te.el.removeAttribute('contenteditable');
  te.el.classList.remove('editing');
  te.el.blur();                                       // ensure the keyboard closes on iOS
  if (!n) { commitStep(); return; }
  if (cancel && te.isNew){                            // Esc on a freshly-created frame = cancel creation
    discardNewCard(n.id, 'Cancelled new card');
    return;
  }
  if (!cancel) {
    setNoteText(n, val);
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
// (continuing a list item — utils/md-edit.ts has the writing helpers), Esc cancels, blur commits.
export function autosizeBody(ta: HTMLTextAreaElement): void { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
// Paste a URL over selected text and the text becomes a LINK — or, if it already is one, keeps its
// label and takes the new URL (utils/markdown.ts linkPaste owns that rule). Bound by every editor
// that holds a note's text: the card's own textarea, the outline's and the mobile sheet's. It writes
// nothing but the textarea and then dispatches `input`, so each editor's own live path runs — the
// card's reflow, the outline's write-through — and none of them needs to know this happened.
// Returns whether it handled the event, so an image paste still gets its turn.
function pasteUrlLink(e: ClipboardEvent, ta: HTMLTextAreaElement): boolean {
  if (state.readOnly) {
    return false;
  }
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
type Caret = 'title' | 'end' | { x: number; y: number };
function startCardEdit(n: MindNode, { caret = 'end', isNew = false }: { caret?: Caret; isNew?: boolean } = {}): void {
  if (state.readOnly || !n) {
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
    endTitleEdit();                            // …including a frame's label
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
  // A double-click's point is read off the RENDERED note, so it has to be read before the textarea replaces it.
  const clicked = typeof caret === 'object' ? clickedOffset(bodyEl, text, caret) : null;
  ta.className = 'body-edit'; ta.spellcheck = false; ta.value = text;
  // `isNew` marks a just-created card: Escape then cancels the whole creation (deletes it), rather
  // than just reverting the edit the way it does for an existing card.
  ta.rows = 1;   // a textarea's default is 2 rows: a one-line card would grow a line just by opening
  ui.bodyEdit = { id:n.id, orig:text, el:bodyEl, ta, isNew, holdH: n.el.getBoundingClientRect().height / (state.view.k || 1) };
  n.el.classList.remove('no-body');                            // give the body slot room while editing
  // The textarea REPLACES the rendered note, so the render cache paintNode keys `.body` on is no longer
  // describing what's in there — clear it, or committing an edit that changed nothing would leave the
  // textarea sitting in the card (the guarded re-render would see a matching key and skip).
  delete bodyEl.dataset.md;
  bodyEl.innerHTML = ''; bodyEl.appendChild(ta);
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
  });
  ta.addEventListener('keydown', (e) => onBodyKeydown(e, n));
  ta.addEventListener('blur',    () => {
    if (ui.bodyEdit && ui.bodyEdit.id === n.id) {
      endBodyEdit();
    }
  });
  // a URL over a selection links it; anything else falls through to the image paste / the native insert
  ta.addEventListener('paste',   (e) => {
    if (!pasteSheet(e, ta) && !pasteUrlLink(e, ta)) {
      onBodyPaste(e);
    }
  });
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());   // place the caret, don't drag the card
  ta.focus();
  autosizeBody(ta);              // size to content first so the card's real height is known…
  relayout();    // …then reflow siblings around it (not just after a newline)
  const [from, to] = clicked != null ? [clicked, clicked] : caretIn(text, caret === 'title' ? 'title' : 'end');
  ta.setSelectionRange(from, to);
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
// Where in the SOURCE a point on the rendered note is: the text node under the point and the offset
// into it (the browser's own hit test), mapped through md-edit.ts sourceOffset. Past the title heading,
// which isn't in `.body`. Null for a miss (an image, a gap), leaving the caret at the end as before.
function clickedOffset(bodyEl: HTMLElement, text: string, at: { x: number; y: number }): number | null {
  const d = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  let node: Node | null = null, off = 0;
  const p = typeof d.caretPositionFromPoint === 'function' ? d.caretPositionFromPoint(at.x, at.y) : null;
  if (p) { node = p.offsetNode; off = p.offset; }
  else { const r = d.caretRangeFromPoint?.(at.x, at.y); if (r) { node = r.startContainer; off = r.startOffset; } }
  if (!node || node.nodeType !== Node.TEXT_NODE || !bodyEl.contains(node)) {
    return null;
  }
  const texts: string[] = [];
  let hit = -1;
  const w = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) {
    if (t === node) {
      hit = texts.length;
    }
    texts.push(t.textContent ?? '');
    if (hit >= 0) {
      break;
    }
  }
  if (hit < 0) {
    return null;
  }
  const h = headingOf(text);
  return sourceOffset(text, h ? h.at + h.title.length : 0, texts, hit, off);
}
// The heading of the FIRST non-blank line, which is the only one that can be a note's title — the
// format rule itself lives in utils/frontmatter.ts, so seeding, the caret and the strip below all read
// one regex instead of three that have to be kept in agreement. `at` is the offset of the title's first
// character into the WHOLE text, since that's what a caret is measured in: the heading need not be on
// line 0 (a note may open with blank lines), and a marker length alone would then be off by them.
function headingOf(text: string): { at: number; title: string } | null {
  const lines = text.split('\n');
  const i = firstTextLine(lines);
  if (i < 0) {
    return null;
  }
  const h = headingOnLine(lines[i]);
  if (!h) {
    return null;
  }
  let start = 0;
  for (let k = 0; k < i; k++) {
    start += lines[k].length + 1;
  }
  return { at: start + h.markerLen, title: h.title };
}
// Where the caret goes. 'title' SELECTS the name so typing replaces it — which is what the old rename
// editor's select-all did — but only the NAME, not the `# ` that marks it as one, or the first keystroke
// would demote the card's title to a plain first line. An UNTITLED card has no name to select, so the
// caret goes to the very start of the note — the one spot where typing `# Something` names it.
function caretIn(text: string, caret: 'title' | 'end'): [number, number] {
  if (caret === 'end') {
    return [text.length, text.length];
  }
  const h = headingOf(text);
  if (!h) {
    return [0, 0];
  }
  return [h.at, h.at + h.title.length];
}
// "Edit the note" — the same one editor, caret past the name rather than on it. Kept as its own name
// because that's what its callers mean (double-click the body, `E`, the pen). A double-click passes
// its point, and the caret lands on the word it hit.
export function startBodyEdit(n: MindNode, at?: { x: number; y: number }): void {
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
  const ta = ui.bodyEdit.ta, mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  const edit = (r: TextEdit | null): void => { if (r){ e.preventDefault(); applyTextEdit(ta, r); } };
  if (e.key === 'Escape') {
    e.preventDefault();
    endBodyEdit({ cancel:true });
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
  // ⌥↑/⌥↓ move the line(s) — an item with its nested children — past the neighbour.
  else if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    edit(renumbered(moveLines(ta.value, ta.selectionStart, ta.selectionEnd, e.key === 'ArrowUp')));
  }
  // Tab walks a table's cells; elsewhere it nests, ⇧Tab un-nests — and never moves focus, which would
  // blur the card shut mid-note.
  else if (e.key === 'Tab' && !mod && !e.altKey) {
    const [v, a, b] = [ta.value, ta.selectionStart, ta.selectionEnd];
    edit(tableTab(v, a, b, e.shiftKey) ?? renumbered(indentLines(v, a, b, e.shiftKey)));
  } else if (mod && !e.altKey && !e.shiftKey && k === 'b') {
    edit(toggleWrap(ta.value, ta.selectionStart, ta.selectionEnd, '**'));
  } else if (mod && !e.altKey && !e.shiftKey && k === 'i') {
    edit(toggleWrap(ta.value, ta.selectionStart, ta.selectionEnd, '*'));
  } else if (mod && !e.altKey && !e.shiftKey && k === 'l') {
    edit(taskLines(ta.value, ta.selectionStart, ta.selectionEnd));
  } else if (mod && !e.altKey && e.shiftKey && k === 'x') {
    edit(toggleWrap(ta.value, ta.selectionStart, ta.selectionEnd, '~~'));
  }
}
// Commit (or cancel) the edit. Commit SPLITS the textarea back into the card's title and note
// (splitHeading — the leading `# ` line is the name, everything else the body, and no heading means
// the card is untitled); cancel leaves both untouched. Either way we drop the textarea and re-render.
export function endBodyEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const be = ui.bodyEdit;
  if (!be) {
    return;
  }
  ui.bodyEdit = null;                                   // null first → the blur handler becomes a no-op
  be.ta.blur();                                         // ensure keyboard closes on iOS when ended by keypress
  const n = state.nodes.get(be.id);
  be.el.classList.remove('editing');
  if (!n) { commitStep(); return; }
  // A brand-new card committed with NOTHING in it is discarded, exactly as Escape would: it has no
  // title, no text, and so no name anything could show it under. Clicking away from a card you never typed
  // into means you didn't want it, which is what Bear and Apple Notes do with an empty note too. Only
  // when isNew — emptying an EXISTING card is an edit, and it keeps its file, children and position; that
  // card reads as "No-title N" in a list (nodeLabel) and stays blank across a reload, which is what
  // serializeMd's `mm_blank` is for.
  if (be.isNew && !be.ta.value.trim()){
    discardNewCard(n.id);
    return;
  }
  // …and one with text in it is KEPT, whichever way the edit ends: Esc on a fresh card is "done
  // typing", not "throw this away" (capture costs nothing — docs/PRODUCT.md). ⌘Z still removes it.
  if (be.isNew) {
    cancel = false;
  }
  const changed = !cancel && be.ta.value !== be.orig;
  if (changed){
    // No sweeping-up of a bare `# ` first line here either: nothing puts one there but the user now,
    // and deleting what somebody typed is worse than leaving an empty heading in their note.
    setNoteText(n, be.ta.value);
    n.dirty = true;
  }
  remeasure();               // re-render and reflow the height change
  // A note that grew past its frame's edge would be clipped out of sight — grow the frame instead.
  if (changed && growFramesToHold([n.id])) {
    relayout();
  }
  // The text decides what the bar offers (a card with lines to tuck away can fold): the bar was synced for
  // the text the edit STARTED with, and the card often stays selected after it ends.
  if (changed) { scheduleSave(); syncFloatBar(); }
  commitStep();                                         // no-op sessions (cancel/unchanged) are discarded
}
