// ---------- every action: the keyboard shortcuts, and the ⌘P palette's list (features/palette.ts shows it) ----------
import { createNode, centredAt, newSectionAt, duplicateSelection, createSibling, addCardInside, deleteSelectionKeepChildren, deleteSelection } from './crud.js';
import { worldAtOrCentre, zoomAt } from '../view/camera.js';
import { ui, isTypingInField } from '../core/ui-state.js';
import { exitScope, openSection } from '../nav/sections.js';
import { state, setStatus, isImageCard, isStack, type MindNode } from '../core/state.js';
import { setCollapsedSelection, toggleCollapseSelection, foldScope, expandAll } from './fold.js';
import { selectedIds, selectAll, selectNode, taggableSelection } from './selection.js';
import { focusOrFit } from '../nav/focus.js';
import { openSearch, searchActive, closeSearch } from './search.js';
import { store } from '../data/persistence.js';
import { openPalette, type Command, setPaletteSource, paletteOpen, closePalette } from './palette.js';
import { undo, redo } from './history.js';
import { clearEdgeSelection, deleteSelectedEdge, connectSelection } from './edge-tools.js';
import { tidyShortcut, TIDY_ACTIONS } from './tidy.js';
import { setReadOnly } from './read-only.js';
import { openTagPicker } from './tag-picker.js';
import { toggleTray, trayOpen } from './tag-tray.js';
import { autoSizeSelection, groupSelectionIntoSection } from './float-bar.js';
import { copySelection, cutSelection } from './clipboard.js';
import { toggleLockSelection, anyLocked } from './lock.js';
import { startInlineEdit, startBodyEdit } from './inline-edit.js';
import { openImageAt } from '../main.js';
import { inboxSection, goToInbox } from './inbox.js';
import { canEnter, canOpen, scopeActive } from '../nav/scope.js';
import { hasStackSelected, unstackSelection, stackToSection } from './stacks.js';
import { openGridMenu } from '../view/grid.js';
import { byId } from '../utils/dom.js';
import { showStart } from '../boot.js';
import { flushSave } from '../data/save.js';
import { nodesOf } from '../utils/model.js';
import { exportZip } from '../data/zip-io.js';

// A new card AT THE POINTER (the viewport centre before the mouse has moved) — what `N`/⌘N do, and
// what a Space tap used to.
function newCardAtPointer(): void {
  createNode(centredAt(worldAtOrCentre(ui.lastMouse?.x, ui.lastMouse?.y)));
}

// …and an empty SECTION there, named on the spot — the palette's "New section".
function newSectionAtPointer(): void {
  newSectionAt(worldAtOrCentre(ui.lastMouse?.x, ui.lastMouse?.y));
}

// Zoom about the middle of the screen — ⌘+/⌘− and the palette's Zoom in/out.
function zoomStep(factor: number): void {
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor);
}
// ---------- arrow keys: go IN and OUT of sections, fold and unfold branches ----------
//   ⌘↓ open the selected section (nav/scope.ts)       ⌘↑ leave the open one — Finder's keys
//   →  unfold                                        ←  fold
// The four keys are about DEPTH, in the two senses this map has: which folder you're standing in,
// and whether a branch is showing. Walking siblings and stepping onto a child lost their keys to
// that, deliberately — opening a section is now the primary way to navigate a big map, and clicking
// covers moving between siblings.
// They were never geometric and still aren't — a child now lives INSIDE its parent, so there is no
// direction from one to the other for an arrow key to mean.
// ←/→ are DIRECTIONAL, unlike the chip / X / the ⋯ menu, which all toggle: pressing → twice can't
// fold what it just unfolded. They act on the WHOLE selection (setCollapsedSelection), like the chip
// and X do — a fold is something you do to cards, and there's no reason a keyboard fold should reach
// fewer of them than a click does.
function navArrow(key: string): void {
  // ⌘↑ reads the SCOPE, not the selection, so it still works right after clicking empty space to
  // deselect — which is exactly when you want to go back up. Inert at the top level, silently: a
  // status line there would nag on every repeat press.
  if (key === 'ArrowUp') { exitScope(); return; }
  const n = state.selId ? state.nodes.get(state.selId) : null;
  if (key === 'ArrowDown') {
    // ⌘↓ stays single: you can only stand in one place, so it acts on the anchor.
    if (!n) { setStatus('Select a section to open it'); return; }
    openSection(n);          // reports its own refusal for the kinds that can't be opened
    return;
  }
  if (!n) {
    return;          // ←/→ have nothing to fold
  }
  // → unfolds, ← folds — every selected card that isn't already there.
  setCollapsedSelection(selectedIds(), key === 'ArrowLeft');
}
// keyboard:
//  · N / ⌘N        → new node at the pointer   (Space: hand-pan; on an image card, open the picture)
//  · Enter          → a new card below the selected one, in the same place
//  · Tab            → a new card inside the selected section
//  · F2             → rename the selected node in place (also: double-click its title)
//  · X              → collapse/eXpand the selected node(s) (also: the corner chip)
//  · ⌘↓ ⌘↑ → ←      → open/leave a section, unfold/fold
//  · E              → edit the selected node's note/body in place (also: double-click the body)
//  · #              → tag the selected cards (features/tag-picker.ts), or with none find by tag
//  · ⌘F or /        → find, by text and #tags (features/search.ts); Esc ends a standing search first
//  · T              → the tag tray (features/tag-tray.ts)
//  · Delete/Backspace → delete the selected node (only when the edit panel is closed)
// A focused title editor (the sidebar field OR an in-card inline rename) counts as "typing",
// so these card shortcuts stay out of the way while you're naming something.
window.addEventListener('keydown', (e) => {
  // The letter shortcuts below are case-INSENSITIVE (Caps Lock, or a held ⇧ that means something of
  // its own like ⇧D), so a single printable character is folded down once here rather than tested
  // twice per line. Named keys keep their own spelling — 'F2' must not become 'f2', nor 'ArrowUp'
  // 'arrowup' — hence the length test rather than a blanket toLowerCase.
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.metaKey || e.ctrlKey;
  const del = key === 'Delete' || key === 'Backspace';

  // Intercept browser zoom shortcuts (Cmd/Ctrl +/-/0) so they drive the canvas, not the viewport.
  // Must be checked before the `typing` guard so they work even while a text field is focused.
  if (mod) {
    if (key === '=' || key === '+') { e.preventDefault(); zoomStep(1.2); return; }
    if (key === '-')                { e.preventDefault(); zoomStep(1 / 1.2); return; }
    if (key === '0')                { e.preventDefault(); focusOrFit(); return; }
    // ⌘F is FIND here, the way it is on every canvas app — not the browser's find-in-page
    if (key === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); openSearch(); return; }
    // ⌘S wraps the selection in a new section (FigJam); with nothing selected it still saves now.
    if (key === 's') {
      e.preventDefault();
      if (state.sel.size && !isTypingInField()) {
        groupSelectionIntoSection();
      } else {
        flushSave();
      }
      return;
    }

    // ⌥⇧⌘R is Figma's Resize to fit — by KEY CODE, since ⌥ rewrites the letter on a Mac.
    if (e.code === 'KeyR' && e.altKey && e.shiftKey) {
      e.preventDefault();
      if (state.sel.size && !isTypingInField() && !state.readOnly) {
        autoSizeSelection();
      }
      return;
    }

    // ⌘P is FigJam's quick actions. Never the browser's print dialog, even while typing in a card.
    if (key === 'p') {
      e.preventDefault();
      if (!isTypingInField()) {
        openPalette();
      }
      return;
    }

    // While typing, ⌘A and ⌘Z/⌘Y belong to the field (its own select-all and native undo).
    if (!isTypingInField() && (key === 'a' || key === 'z' || key === 'y')) {
      e.preventDefault();
      if (key === 'a') {
        selectAll();
      } else if (key === 'z' && !e.shiftKey) {
        undo();
      } else {
        redo();
      }
      return;
    }
  }

  const active = document.activeElement as HTMLElement | null;
  const typing = isTypingInField();
  // Esc blurs the active field (so Delete works next), or deselects when not typing.
  if (key === 'Escape'){
    e.preventDefault();
    if (typing) {
      active?.blur?.();
    } else if (state.selEdges.size) {
      clearEdgeSelection();
    } else if (searchActive()) {
      closeSearch();   // a search left standing over the board, before the selection
    } else if (state.sel.size) {
      selectNode(null);
    }
    return;
  }
  if (typing) {
    return;
  }
  if (tidyShortcut(e)) {
    return;   // ⌥A/H/D/W/V/S align, ⌃⌥T/H/V tidy and distribute (features/tidy.ts)
  }
  // ⌘↓/⌘↑ go in and out, →/← unfold and fold (navArrow). Plain ↑/↓ and ⇧/⌥ arrows are left free for
  // the browser and for later (extend-selection).
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (key.startsWith('Arrow') && !e.shiftKey && !e.altKey && mod === vertical){
    e.preventDefault(); navArrow(key); return;
  }
  if (key === 'r'){ e.preventDefault(); setReadOnly(!state.readOnly); return; }
  if (key === '/'){ e.preventDefault(); openSearch(); return; }   // find a card
  // #: tag the selected cards (features/tag-picker.ts) — or, with none, find by tag
  if (key === '#' && !mod){
    e.preventDefault();
    if (taggableSelection().length) {
      openTagPicker();
    } else {
      openSearch('#');
    }
    return;
  }
  if (key === 't' && !mod && !e.altKey && !e.shiftKey){ e.preventDefault(); toggleTray(); return; }   // the tag tray
  // NEW CARD, at the pointer. ⌘N is the name everyone knows it by — but on macOS Chrome/Safari it is an
  // application-menu accelerator (File ▸ New Window) and never reaches the page, so plain `N` carries the
  // shortcut in practice and sits in the same family as the app's other bare letters (A/E/X/D/F/O/S).
  // Both are bound: whichever the browser lets through does the same thing.
  if (key === 'n' && !e.shiftKey && !e.altKey){ e.preventDefault(); newCardAtPointer(); return; }
  // Space = hand-tool to pan while held (a tap on a selected image card opens it — see the keyup below).
  if (key === ' '){ e.preventDefault(); if (!e.repeat){ ui.spaceHeld = true; ui.spaceUsedForPan = false; } return; }
  if (key === 'f'){ e.preventDefault(); focusOrFit(); return; }
  if (key === 'd' && state.sel.size){ e.preventDefault(); duplicateSelection({ next: e.shiftKey }); return; }   // ⇧D: the SMART duplicate (crud.ts copyNext)
  // ⌘/Ctrl C / X copy / cut the selected cards (with their subtrees). No ⌘V handler here —
  // the native `paste` event (features/attachments.ts) carries clipboardData permission-free.
  if (key === 'c' && mod && state.sel.size){ e.preventDefault(); void copySelection(); return; }
  if (key === 'x' && mod && state.sel.size){ e.preventDefault(); void cutSelection(); return; }
  if (key === 'x' && !mod && state.sel.size){   // don't shadow cut
    e.preventDefault(); toggleCollapseSelection(state.sel); return;
  }
  if (key === 'l' && !mod && state.sel.size && !state.readOnly){
    e.preventDefault();
    toggleLockSelection();
    return;
  }
  // image cards have no title/body UI to rename or edit — they're a leaf that shows only the image
  if (key === 'F2' && state.selId){
    e.preventDefault(); startInlineEdit(state.nodes.get(state.selId)); return;   // selId guards non-null
  }
  if (key === 'e' && !mod && state.selId){
    e.preventDefault(); const n = state.nodes.get(state.selId);
    if (n) {
      startBodyEdit(n);
    }
    return;
  }
  if (key === 'Enter' && state.selId){ e.preventDefault(); createSibling(state.selId); return; }
  // Tab puts a new card INSIDE the selected section — the one thing that has an inside.
  if (key === 'Tab' && state.selId){
    e.preventDefault();
    if (canOpen(state.nodes.get(state.selId))) {
      addCardInside(state.selId);
    }
    return;
  }
  if (del && state.selEdges.size){ e.preventDefault(); deleteSelectedEdge(); return; }
  // ⌘L connects the selected cards (MindNode's shortcut for the same thing). Bare `l` is lock.
  if (key === 'l' && mod && state.sel.size){ e.preventDefault(); connectSelection(); return; }
  if (del && state.sel.size){
    e.preventDefault();
    // ⌘⌫ (FigJam's Ungroup) and ⌥⌫ keep a section's cards, promoting them to its parent.
    if (e.altKey || (mod && nodesOf(selectedIds()).some(n => n.type === 'section'))) {
      deleteSelectionKeepChildren();
    } else {
      deleteSelection();
    }
  }
});
// Track the mouse so keyboard/clipboard actions (Space-tap, paste) land AT the pointer.
window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') {
    ui.lastMouse = { x: e.clientX, y: e.clientY };
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key !== ' ') {
    return;
  }
  const wasPan = ui.spaceUsedForPan;
  ui.spaceHeld = false; ui.spaceUsedForPan = false;
  if (isTypingInField() || wasPan || ui.pan) {
    return;
  }
  // A Space TAP on a lone IMAGE card opens it full-screen — the picture is the whole card, so "look at
  // this properly" is the obvious thing the key can mean there, and the viewer closes on Space too
  // (features/image-viewer.ts). Everything else Space used to do on release (making a card) is `N` now.
  const sole = state.sel.size === 1 && state.selId ? state.nodes.get(state.selId) : null;
  if (sole && isImageCard(sole)) {
    openImageAt(sole, sole.el?.querySelector('img.md-img') ?? null);
  }
});
// ---------- the ⌘P command palette's list ----------
// Every action the app has, with the shortcut that does the same — built here because every action
// function is in scope here. `when` hides what can't apply right now (features/palette.ts).
const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl ';
const editable = (): boolean => !state.readOnly && store.isOpen;
const hasSel = (): boolean => state.sel.size > 0 && editable();
const oneSel = (): MindNode | undefined => state.sel.size === 1 && state.selId ? state.nodes.get(state.selId) : undefined;
// A section in the selection that is a box, not a stack — what decides Ungroup against Unstack.
const plainSectionSelected = (): boolean => nodesOf(selectedIds()).some(n => n.type === 'section' && !isStack(n));

function paletteCommands(): Command[] {
  return [
    { label: 'New card', shortcut: 'N', keywords: 'add create note', when: editable, run: newCardAtPointer },
    { label: 'Find…', shortcut: MOD + 'F', keywords: 'search filter tags card', run: () => openSearch() },
    { label: trayOpen() ? 'Hide the tag tray' : 'Show the tag tray', shortcut: 'T', keywords: 'tags stickers emoji', run: () => toggleTray() },
    { label: 'Undo', shortcut: MOD + 'Z', when: editable, run: undo },
    { label: 'Redo', shortcut: '⇧' + MOD + 'Z', when: editable, run: redo },
    { label: state.selId ? 'Focus the selection' : 'Fit the map to the screen', shortcut: 'F', keywords: 'zoom view', run: focusOrFit },
    { label: 'Zoom in', shortcut: MOD + '+', run: () => zoomStep(1.2) },
    { label: 'Zoom out', shortcut: MOD + '−', run: () => zoomStep(1 / 1.2) },
    { label: 'Select all', shortcut: MOD + 'A', run: selectAll },
    { label: 'Edit the note', shortcut: 'E', when: () => editable() && !!oneSel(), run: () => {
      const n = oneSel();
      if (n) {
        startBodyEdit(n);
      }
    } },
    { label: 'Add a card inside the section', shortcut: 'Tab', keywords: 'child', when: () => editable() && canOpen(oneSel()), run: () => addCardInside(state.selId!) },
    { label: 'New section', keywords: 'group box section', when: editable, run: newSectionAtPointer },
    { label: 'Inbox', keywords: 'phone capture new notes icloud', when: () => !!inboxSection() || editable(), run: goToInbox },
    { label: 'Leave the section', shortcut: MOD + '↑', keywords: 'exit back up out parent', when: scopeActive, run: exitScope },
    { label: 'Add a card after', shortcut: 'Enter', keywords: 'sibling', when: () => editable() && !!oneSel(), run: () => createSibling(state.selId!) },
    { label: 'Open', shortcut: MOD + '↓', keywords: 'enter section', when: () => canEnter(oneSel()), run: () => openSection(oneSel()) },
    { label: 'Connect the selected cards', shortcut: MOD + 'L', keywords: 'line edge arrow link', when: () => hasSel() && state.sel.size > 1, run: connectSelection },
    { label: 'Wrap in new section', shortcut: MOD + 'S', keywords: 'group', when: hasSel, run: groupSelectionIntoSection },
    { label: 'Resize to fit', shortcut: '⌥⇧' + MOD + 'R', keywords: 'fit contents auto size shrink grow', when: hasSel, run: autoSizeSelection },
    { label: 'Duplicate', shortcut: 'D', keywords: 'copy', when: hasSel, run: () => duplicateSelection() },
    { label: 'Duplicate as the next one', shortcut: '⇧D', keywords: 'copy smart series next day date increment log', when: hasSel, run: () => duplicateSelection({ next: true }) },
    { label: 'Tag…', shortcut: '#', keywords: 'tags emoji label obsidian', when: () => editable() && taggableSelection().length > 0, run: openTagPicker },
    { label: 'Fold / unfold', shortcut: 'X', keywords: 'collapse expand', when: () => state.sel.size > 0, run: () => toggleCollapseSelection(state.sel) },
    ...TIDY_ACTIONS.map(a => ({ label: a.label, shortcut: a.shortcut || undefined, keywords: 'tidy align arrange distribute layout',
      when: () => !state.readOnly && state.sel.size >= (a.min ?? 2), run: a.run })),
    { label: 'Collapse all', keywords: 'fold every card section', when: () => foldScope().some(n => !n.collapsed), run: () => setCollapsedSelection(foldScope().map(n => n.id), true) },
    { label: 'Expand all', keywords: 'unfold every card section', when: () => foldScope().some(n => n.collapsed), run: expandAll },
    { label: anyLocked(state.sel) ? 'Unlock' : 'Lock', shortcut: 'L', when: hasSel, run: toggleLockSelection },
    // ⌘⌫ is listed once: Unstack when only stacks are selected, else Ungroup, which unstacks the stacks among them too
    { label: 'Unstack', shortcut: MOD + '⌫', keywords: 'stack pile spread cards out', when: () => hasStackSelected() && !plainSectionSelected(), run: unstackSelection },
    { label: 'Turn into section', keywords: 'stack pile box convert', when: hasStackSelected, run: stackToSection },
    { label: 'Ungroup', shortcut: MOD + '⌫', keywords: 'delete section keep cards', when: () => editable() && plainSectionSelected(), run: deleteSelectionKeepChildren },
    { label: 'Delete', shortcut: '⌫', keywords: 'remove', when: hasSel, run: deleteSelection },
    { label: state.readOnly ? 'Edit again (leave read-only)' : 'Read-only mode', shortcut: 'R', keywords: 'lock view', run: () => setReadOnly(!state.readOnly) },
    { label: 'Background grid…', keywords: 'dots lines snap', run: openGridMenu },
    { label: 'Canvas colour…', keywords: 'background', when: () => !state.readOnly, run: () => byId('canvasColorBtn').click() },
    { label: 'Your maps…', keywords: 'home open folder switch', run: showStart },
    { label: 'Export the map as .zip', keywords: 'backup download', when: () => store.isOpen, run: () => { void exportZip(); } },
  ];
}
setPaletteSource(paletteCommands);
byId('paletteBtn').title = `Actions (${MOD.trim() === '⌘' ? '⌘P' : 'Ctrl+P'})`;
byId('paletteBtn').onclick = (e) => {
  e.stopPropagation();
  if (paletteOpen()) {
    closePalette();
  } else {
    openPalette();
  }
};
