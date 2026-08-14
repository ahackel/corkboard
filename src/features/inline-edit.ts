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
import { state, setStatus, isAnnotation, isQueryCard, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { isLockedEffective } from '../utils/model.js';
import { joinHeading, splitHeading, firstTextLine, headingOnLine } from '../utils/frontmatter.js';
import { linkPaste } from '../utils/markdown.js';
import { outlineActive, startRowTitleEdit } from './outline.js';
import { actionTarget, isTabsFrame } from '../view/layout.js';
import { scheduleSave } from '../data/persistence.js';
import { onBodyPaste } from './attachments.js';
import { selectNode, startQueryEdit, toggleCollapse, relayout, remeasure } from '../main.js';
import { openBranchEditor, branchEditorOpen } from './branch-editor.js';
import { extractToChild, discardNewCard } from './crud.js';
import { touch, commitStep } from './history.js';

// The text the editor holds: the note with its title back on the front as a heading — exactly the
// file's own body (utils/frontmatter.ts joinHeading), which is what makes the editor a view of the
// note rather than a form over two fields. `titleGap` rides along for the same reason: delete the
// blank line under a heading and the editor must not put it back on the next open.
const cardEditText = (n: MindNode): string => joinHeading(n.title, n.body, n.titleGap !== false);

// ---------- rename (F2 / the ⋯ menu / a fresh card / a double-clicked title row) ----------
// Not its own editor any more: it opens the card's one field with the caret on the TITLE. Kept as the
// single rename FUNNEL, so the tab-group redirect, the annotation/query redirects, the outline-mode
// hand-off and the lock refusal all still happen in exactly one place.
export function startInlineEdit(n: MindNode | undefined, { isNew = false }: { isNew?: boolean } = {}): void {
  if (state.readOnly || !n) return;
  // A tab group has no title you can see — renaming "this frame" means renaming the OPEN TAB, which is
  // the name actually on screen. Here rather than at the call sites, so F2, the ⋯ menu and the outline
  // all follow. (A fresh node is never a group, so the isNew rename path is unaffected.)
  // FOLDED, the group's pill shows that same tab's title (main.ts foldedTab), so the redirect has to
  // hold there too — but the tab itself is hidden inside the fold, and an editor on a display:none
  // element can't be typed into. So unfold first, the way focusNode reveals before it acts; a locked
  // group refuses, stays folded, and falls through to the lock check below.
  if (isTabsFrame(n) && n.collapsed) toggleCollapse(n.id);
  n = actionTarget(n);
  if (isLockedEffective(n)) { setStatus('Locked — can’t rename'); return; }
  // An annotation has no title — its double-click / F2 / add-child rename all edit the BODY instead.
  if (isAnnotation(n)) { startBodyEdit(n); return; }
  // A query card's title isn't renamable — its double-click / F2 / "Rename" all edit the query instead.
  if (isQueryCard(n)) { startQueryEdit(n); return; }
  // In outline mode (which includes every phone-width screen — outline is forced on below
  // that breakpoint) the title is renamed right on its row (features/outline.ts), mirroring the
  // canvas' in-place rename. This is the single choke point, so F2 / double-click / add child / add
  // sibling / context menu all follow. The one exception: the single-card editor is already open
  // (e.g. "+" while viewing a card adds a child) — its row doesn't exist in the (hidden) list, so
  // the rename happens on the open card itself instead.
  if (outlineActive()) {
    if (branchEditorOpen()) openBranchEditor(n.id, 'title');
    else startRowTitleEdit(n, { isNew });
    return;
  }
  // A FRAME's label can't live in the card editor — it's a folder TAB of fixed height, and the frame's own
  // `.body` is display:none, so a textarea in there couldn't be focused (see ui-state.ts TitleEdit). Its
  // tab is renamed on itself instead. A STACK is NOT in this bucket any more: its header is its rendered
  // text, so it edits like any card and `# Name` is how you ask for a heading there.
  if (n.type === 'frame') { startTitleEdit(n, { isNew }); return; }
  startCardEdit(n, { caret: 'title', isNew });
}

// ---------- a container's label, renamed in place (one line, on the tab/header itself) ----------
function startTitleEdit(n: MindNode, { isNew = false }: { isNew?: boolean } = {}): void {
  if (!n.el) return;
  if (ui.bodyEdit) endBodyEdit();                                  // close a card editor first
  if (ui.titleEdit) endTitleEdit();                                // …or any other label editor
  touch(n.id);   // the whole edit session becomes ONE undo step (for a fresh frame, incl. its creation)
  if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);
  // Scoped to a DIRECT child: nodeEl builds `.title-row > .title` for every kind, a folded frame and a
  // docked tab included, and a container's child cards are DOM-nested inside it — so an unscoped
  // `.title` lookup could pick a child card's title instead of this node's own.
  const titleEl = n.el.querySelector(':scope > .title-row > .title') as HTMLElement;
  // The tab RENDERS markdown, so editing it has to show the SOURCE — swap the rendered HTML for the raw
  // text for the duration. Otherwise the editor would show `Name` where the file says `# Name`, and
  // committing would write the rendered text back and silently strip the heading away.
  const raw = cardEditText(n);
  ui.titleEdit = { id:n.id, el:titleEl, isNew };
  setCardDraggable(n, false);
  titleEl.textContent = raw;
  titleEl.setAttribute('contenteditable', 'plaintext-only');
  titleEl.classList.add('editing');
  titleEl.focus();
  const r = document.createRange(); r.selectNodeContents(titleEl);     // select-all so typing replaces
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}
// A card element is `draggable` (the ⌥ card-file export, features/clipboard.ts), and a draggable
// ANCESTOR is decisive: the browser resolves any drag begun inside it as that ELEMENT's drag, so a
// mouse can't select text inside a contenteditable while it holds. (A <textarea> is the exception — a
// text control with a selection outranks the ancestor — which is why the CARD editor needs none of
// this.) Every teardown path puts it back; exporting a frame mid-rename isn't a gesture anyone is making.
export function setCardDraggable(n: MindNode | undefined, on: boolean): void {
  if (n?.el) n.el.draggable = on;
}
// Live: reflow as the label grows. n.title is untouched (layout uses the live DOM), so a half-typed
// name can't corrupt anything — and there is nothing to VALIDATE any more (empty and duplicate are
// both legal), which is what took the old `.invalid` outline away.
export function onTitleInput(n: MindNode): void {
  if (!ui.titleEdit || ui.titleEdit.id !== n.id) return;
  relayout();
}
export function onTitleKeydown(e: KeyboardEvent, n: MindNode): void {
  if (!ui.titleEdit || ui.titleEdit.id !== n.id) return;
  if (e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); e.stopPropagation(); endTitleEdit(); }
  else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); endTitleEdit({ cancel:true }); }
}
// Commit (or cancel) a frame rename. The text is MARKDOWN, so it splits like any card's — `# Name` is a
// heading on the tab, `Name` is plain text there — and a frame keeps a REQUIRED name, since an empty
// folder tab is nothing you could grab the box by, so an empty commit falls back to what it had.
// Nothing restores the element's text here: `ui.titleEdit` is nulled first, which lets the paintAll below
// re-render the tab from the fields — the raw source goes away with the editor.
export function endTitleEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const te = ui.titleEdit; if (!te) return;
  ui.titleEdit = null;                                // null first → the blur handler becomes a no-op
  const n = state.nodes.get(te.id);
  setCardDraggable(n, true);
  te.el.removeAttribute('contenteditable');
  te.el.classList.remove('editing');
  te.el.blur();                                       // ensure the keyboard closes on iOS
  if (!n) { commitStep(); return; }
  if (cancel && te.isNew){                            // Esc on a freshly-created frame = cancel creation
    discardNewCard(n.id, 'Cancelled new card');
    return;
  }
  const val = (te.el.textContent ?? '').replace(/[\r\n]+/g, ' ').trim();   // a tab is a single line
  if (!cancel && val){
    const { title, body, gap } = splitHeading(val);
    n.title = title; n.body = body; n.titleGap = gap;
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
// title is in the textarea and showing it twice would read as two fields. Enter inserts a newline,
// Esc cancels, blur commits.
export function autosizeBody(ta: HTMLTextAreaElement): void { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
// Paste a URL over selected text and the text becomes a LINK — or, if it already is one, keeps its
// label and takes the new URL (utils/markdown.ts linkPaste owns that rule). Bound by every editor
// that holds a note's text: the card's own textarea, the outline's and the mobile sheet's. It writes
// nothing but the textarea and then dispatches `input`, so each editor's own live path runs — the
// card's reflow, the outline's write-through — and none of them needs to know this happened.
// Returns whether it handled the event, so an image paste still gets its turn.
export function pasteUrlLink(e: ClipboardEvent, ta: HTMLTextAreaElement): boolean {
  if (state.readOnly) return false;
  const r = linkPaste(ta.value, ta.selectionStart, ta.selectionEnd, e.clipboardData?.getData('text/plain') ?? '');
  if (!r) return false;
  e.preventDefault();
  ta.value = r.text;
  ta.setSelectionRange(r.start, r.end);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
// Where the caret lands: on the card's NAME (selected, so typing replaces it — the old rename's
// select-all) or at the end. 'title' on an untitled card lands at the top and types a heading for you,
// which is the one nudge that keeps F2 meaningful there.
type Caret = 'title' | 'end';
function startCardEdit(n: MindNode, { caret = 'end', isNew = false }: { caret?: Caret; isNew?: boolean } = {}): void {
  if (state.readOnly || !n) return;
  if (isLockedEffective(n)) { setStatus('Locked — can’t edit'); return; }
  if (outlineActive()) { openBranchEditor(n.id, caret === 'title' ? 'title' : 'body'); return; }   // see startInlineEdit
  if (!n.el) return;
  if (ui.bodyEdit && ui.bodyEdit.id === n.id) return;          // already editing this card
  if (ui.bodyEdit) endBodyEdit();                              // close any other open editor
  if (ui.titleEdit) endTitleEdit();                            // …including a container's label
  touch(n.id);   // the whole edit session becomes ONE undo step (for a fresh card, incl. its creation)
  if (state.selId !== n.id || state.sel.size !== 1) selectNode(n.id);
  const bodyEl = n.el.querySelector('.body') as HTMLElement;
  const ta = document.createElement('textarea');
  // A rename of an UNTITLED card seeds a bare `# ` for the name to be typed into (see caretIn) — the one
  // nudge that keeps F2 meaningful with no separate title field to put a caret in. `orig` is the SEEDED
  // text, not the card's, so committing without typing anything still counts as unchanged and writes
  // nothing; endBodyEdit drops the marker again if it's still empty.
  const seeded = caret === 'title' ? seedHeading(cardEditText(n)) : cardEditText(n);
  ta.className = 'body-edit'; ta.spellcheck = false; ta.value = seeded;
  // `isNew` marks a just-created card: Escape then cancels the whole creation (deletes it), rather
  // than just reverting the edit the way it does for an existing card.
  ui.bodyEdit = { id:n.id, orig:seeded, el:bodyEl, ta, isNew };
  n.el.classList.remove('no-body');                            // give the body slot room while editing
  // The textarea REPLACES the rendered note, so the render cache paintNode keys `.body` on is no longer
  // describing what's in there — clear it, or committing an edit that changed nothing would leave the
  // textarea sitting in the card (the guarded re-render would see a matching key and skip).
  delete bodyEl.dataset.md;
  bodyEl.innerHTML = ''; bodyEl.appendChild(ta);
  bodyEl.classList.add('editing');
  // typing: keep the textarea sized to its content and reflow siblings as the card grows/shrinks
  ta.addEventListener('input', () => { autosizeBody(ta); onBodyInput(n); });
  ta.addEventListener('keydown', (e) => onBodyKeydown(e, n));
  ta.addEventListener('blur',    () => { if (ui.bodyEdit && ui.bodyEdit.id === n.id) endBodyEdit(); });
  // a URL over a selection links it; anything else falls through to the image paste / the native insert
  ta.addEventListener('paste',   (e) => { if (!pasteUrlLink(e, ta)) onBodyPaste(e); });
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());   // place the caret, don't drag the card
  ta.focus();
  autosizeBody(ta);              // size to content first so the card's real height is known…
  relayout();    // …then reflow siblings around it (not just after a newline)
  const [from, to] = caretIn(seeded, caret);
  ta.setSelectionRange(from, to);
}
// Give an untitled card a `# ` to type its name into. Only for a rename — "edit the note" must not put
// a marker in a note nobody asked to name.
const SEED = '# ';
const seedHeading = (text: string): string =>
  headingOf(text)?.title ? text : SEED + (text ? '\n\n' + text : '');
// The heading of the FIRST non-blank line, which is the only one that can be a note's title — the
// format rule itself lives in utils/frontmatter.ts, so seeding, the caret and the strip below all read
// one regex instead of three that have to be kept in agreement. `at` is the offset of the title's first
// character into the WHOLE text, since that's what a caret is measured in: the heading need not be on
// line 0 (a note may open with blank lines), and a marker length alone would then be off by them.
function headingOf(text: string): { at: number; title: string } | null {
  const lines = text.split('\n');
  const i = firstTextLine(lines);
  if (i < 0) return null;
  const h = headingOnLine(lines[i]);
  if (!h) return null;
  let start = 0;
  for (let k = 0; k < i; k++) start += lines[k].length + 1;
  return { at: start + h.markerLen, title: h.title };
}
// Where the caret goes. 'title' SELECTS the name so typing replaces it — which is what the old rename
// editor's select-all did — but only the NAME, not the `# ` that marks it as one, or the first keystroke
// would demote the card's title to a plain first line. On a just-seeded card there's nothing to select,
// so the caret sits after the marker.
function caretIn(text: string, caret: Caret): [number, number] {
  if (caret === 'end') return [text.length, text.length];
  const h = headingOf(text);
  if (!h) return [SEED.length, SEED.length];
  return [h.at, h.at + h.title.length];
}
// "Edit the note" — the same one editor, caret past the name rather than on it. Kept as its own name
// because that's what its callers mean (double-click the body, `E`, the pen, an annotation's rename
// redirect).
export function startBodyEdit(n: MindNode): void {
  startCardEdit(n, { caret: 'end' });
}
// A rename seeds `# ` for the name to be typed into (seedHeading). If it's STILL empty at commit — the
// user typed the note instead, or changed their mind — the bare marker would otherwise survive as the
// note's first line, since splitHeading rightly refuses to read a marker with nothing after it as a
// title. So the empty line goes here, at the one place a human's half-finished text becomes a note.
function dropEmptyHeading(text: string): string {
  const lines = text.split('\n');
  const i = firstTextLine(lines);
  if (i >= 0 && /^#{1,6}$/.test(lines[i].trim())) lines.splice(i, 1);
  return lines.join('\n').trim();
}
// Drop the editor WITHOUT reading the textarea back, because the caller (crud.ts cutBodyRange) has
// already written the shortened n.body and endBodyEdit would commit the textarea's pre-cut value
// straight over it. The textarea element itself goes with the next paintNode, which re-renders .body
// once no editor claims this card.
export function dropBodyEdit(): void {
  const be = ui.bodyEdit; if (!be) return;
  ui.bodyEdit = null;
  be.el.classList.remove('editing');
}
// Live: reflow as the user types. n.body isn't touched here (layout uses the live DOM height),
// so an in-progress edit can't corrupt anything — the textarea content is preserved by paintNode.
function onBodyInput(n: MindNode): void {
  if (!ui.bodyEdit || ui.bodyEdit.id !== n.id) return;
  relayout();
}
function onBodyKeydown(e: KeyboardEvent, n: MindNode): void {
  if (!ui.bodyEdit || ui.bodyEdit.id !== n.id) return;
  e.stopPropagation();                                  // keep canvas/card shortcuts out while typing
  if (e.key === 'Escape'){ e.preventDefault(); endBodyEdit({ cancel:true }); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter'){ e.preventDefault(); endBodyEdit(); }
  else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'e' || e.key === 'E')){ e.preventDefault(); extractToChild(); }
  // plain Enter falls through → the textarea inserts a newline (notes are multi-line)
}
// Commit (or cancel) the edit. Commit SPLITS the textarea back into the card's title and note
// (splitHeading — the leading `# ` line is the name, everything else the body, and no heading means
// the card is untitled); cancel leaves both untouched. Either way we drop the textarea and re-render.
export function endBodyEdit({ cancel = false }: { cancel?: boolean } = {}): void {
  const be = ui.bodyEdit; if (!be) return;
  ui.bodyEdit = null;                                   // null first → the blur handler becomes a no-op
  be.ta.blur();                                         // ensure keyboard closes on iOS when ended by keypress
  const n = state.nodes.get(be.id);
  be.el.classList.remove('editing');
  if (!n) { commitStep(); return; }
  // A brand-new card committed with NOTHING in it is discarded, exactly as Escape would: it has no
  // title, no text, and so no name anything could show it under — the third and last way the word
  // "Untitled" used to reach the screen (the other two: an unmigrated body-less note, seeded from its
  // filename at load, and nodeLabel's own filename fallback). Clicking away from a card you never typed
  // into means you didn't want it, which is what Bear and Apple Notes do with an empty note too. Only
  // when isNew — emptying an EXISTING card is an edit, and it keeps its file, children and position.
  if (be.isNew && !be.ta.value.trim()){
    discardNewCard(n.id);
    return;
  }
  if (cancel && be.isNew){                              // Esc on a freshly-created card = cancel creation
    discardNewCard(n.id, 'Cancelled new card');
    return;
  }
  const changed = !cancel && be.ta.value !== be.orig;
  if (changed){
    const { title, body, gap } = splitHeading(dropEmptyHeading(be.ta.value));
    n.title = title; n.body = body; n.titleGap = gap;
    n.dirty = true;
  }
  remeasure();               // re-render and reflow the height change
  if (changed) scheduleSave();
  commitStep();                                         // no-op sessions (cancel/unchanged) are discarded
}
