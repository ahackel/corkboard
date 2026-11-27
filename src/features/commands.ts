// Every action: the keyboard shortcuts, and the ⌘P palette's list.
import { createNode, centredAt, newSectionAt, duplicateSelection, createSibling, addCardInside, deleteSelectionKeepChildren, deleteSelection } from './crud.js';
import { worldAtOrCentre, zoomAt } from '../view/camera.js';
import { ui, isTypingInField } from '../core/ui-state.js';
import { exitScope, openSection } from '../nav/sections.js';
import { state, setStatus, isImageCard, isStack, type MindNode } from '../core/state.js';
import { setCollapsedSelection, toggleCollapseSelection, foldScope, expandAll } from './fold.js';
import { selectedIds, selectAll, selectNode, taggableSelection } from './selection.js';
import { focusOrFit } from '../nav/focus.js';
import { openSearch, searchActive, closeSearch } from './search.js';
import { store } from '../data/active-store.js';
import { openPalette, type Command, setPaletteSource, paletteOpen, closePalette } from './palette.js';
import { undo, redo } from './history.js';
import { clearEdgeSelection, deleteSelectedEdge, connectSelection } from './edge-tools.js';
import { pasteFromClipboard, pickImagesAt } from './attachments.js';
import { copyFilePath } from './context-menu.js';
import { tidyShortcut, TIDY_ACTIONS, canTidySection, tidySection } from './tidy.js';
import { openTagPicker } from './tag-picker.js';
import { toggleTray, trayOpen } from './tag-tray.js';
import { autoSizeSelection, groupSelectionIntoSection, colorSelection, KEY_COLORS } from './float-bar.js';
import { copySelection, copyFormatted, cutSelection, exportSelection, shareSelection, canShareFiles } from './clipboard.js';
import { toggleLockSelection, anyLocked } from './lock.js';
import { startInlineEdit, startBodyEdit } from './inline-edit.js';
import { openImageAt } from './activate.js';
import { inboxSection, goToInbox } from './inbox.js';
import { canEnter, canOpen, scopeActive } from '../nav/scope.js';
import { hasStackSelected, unstackSelection, stackToSection } from './stacks.js';
import { openSettings } from './canvas-color.js';
import { byId, keys } from '../utils/dom.js';
import { showStart, pickNote, newDeviceMap } from '../boot.js';
import { flushSave } from '../data/save.js';
import { nodesOf } from '../utils/model.js';
import { exportZip, openImportPicker } from '../data/zip-io.js';
import { exportImage, type ImageFormat } from './export-image.js';

function newCardAtPointer(): void {
  createNode(centredAt(worldAtOrCentre(ui.lastMouse?.x, ui.lastMouse?.y)));
}

function newSectionAtPointer(): void {
  newSectionAt(worldAtOrCentre(ui.lastMouse?.x, ui.lastMouse?.y));
}

function pointerOrCentre(): { x: number; y: number } {
  return ui.lastMouse ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

const ZOOM_STEP = 1.2;

function zoomStep(factor: number): void {
  zoomAt(window.innerWidth / 2, window.innerHeight / 2, factor);
}

// ⌘↓/⌘↑ open and leave a section; →/← unfold and fold, DIRECTIONALLY (unlike X, which toggles).
// See "Arrow keys go IN and OUT" in docs/architecture.md.
function navArrow(key: string): void {
  // Reads the SCOPE, not the selection, so it works right after deselecting.
  if (key === 'ArrowUp') { exitScope(); return; }
  const n = state.selId ? state.nodes.get(state.selId) : null;
  if (key === 'ArrowDown') {
    if (!n) { setStatus('Select a section to open it'); return; }
    openSection(n);
    return;
  }
  if (!n) {
    return;
  }
  setCollapsedSelection(selectedIds(), key === 'ArrowLeft');
}

function onShortcutKey(e: KeyboardEvent): void {
  // Letters are case-insensitive (Caps Lock, ⇧D); named keys like 'F2' keep their spelling.
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = e.metaKey || e.ctrlKey;
  const del = key === 'Delete' || key === 'Backspace';

  // Ahead of the typing guard, so even a focused field never hands these to the browser.
  if (mod) {
    if (key === '=' || key === '+') { e.preventDefault(); zoomStep(ZOOM_STEP); return; }
    if (key === '-')                { e.preventDefault(); zoomStep(1 / ZOOM_STEP); return; }
    if (key === '0')                { e.preventDefault(); focusOrFit(); return; }
    if (key === 'f' && !e.shiftKey && !e.altKey) { e.preventDefault(); openSearch(); return; }
    if (key === 's') {
      e.preventDefault();
      if (state.sel.size && !isTypingInField()) {
        groupSelectionIntoSection();
      } else {
        flushSave();
      }
      return;
    }

    // By KEY CODE: ⌥ rewrites the letter on a Mac.
    if (e.code === 'KeyR' && e.altKey && e.shiftKey) {
      e.preventDefault();
      if (state.sel.size && !isTypingInField()) {
        autoSizeSelection();
      }
      return;
    }

    if (key === 'p') {
      e.preventDefault();
      if (!isTypingInField()) {
        openPalette();
      }
      return;
    }

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
  // See "Esc peels ONE layer" in docs/architecture.md.
  if (key === 'Escape'){
    e.preventDefault();
    if (typing) {
      active?.blur?.();
    } else if (state.selEdges.size) {
      clearEdgeSelection();
    } else if (searchActive()) {
      closeSearch();
    } else if (state.sel.size) {
      selectNode(null);
    }
    return;
  }
  if (typing) {
    return;
  }
  if (tidyShortcut(e)) {
    return;
  }

  // Plain ↑/↓ and ⇧/⌥ arrows are left to the browser.
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (key.startsWith('Arrow') && !e.shiftKey && !e.altKey && mod === vertical){
    e.preventDefault(); navArrow(key); return;
  }
  if (key === '/'){ e.preventDefault(); openSearch(); return; }
  if (key === '#' && !mod){
    e.preventDefault();
    if (taggableSelection().length) {
      openTagPicker();
    } else {
      openSearch('#');
    }
    return;
  }
  if (key === 't' && !mod && !e.altKey && !e.shiftKey){ e.preventDefault(); toggleTray(); return; }

  // ⌘N too, though macOS browsers keep it for New Window.
  if (key === 'n' && !e.shiftKey && !e.altKey){ e.preventDefault(); newCardAtPointer(); return; }
  // Held, Space pans; a tap is onSpaceUp's.
  if (key === ' '){ e.preventDefault(); if (!e.repeat){ ui.spaceHeld = true; ui.spaceUsedForPan = false; } return; }
  if (key === 'f'){ e.preventDefault(); focusOrFit(); return; }
  if (/^[1-9]$/.test(key) && !mod && !e.altKey && state.sel.size){ e.preventDefault(); colorSelection(KEY_COLORS[+key - 1]); return; }
  if (key === 'd' && state.sel.size){ e.preventDefault(); duplicateSelection({ next: e.shiftKey }); return; }

  // No ⌘V here: the native `paste` event (attachments.ts) carries clipboardData permission-free.
  if (key === 'c' && mod && state.sel.size){ e.preventDefault(); void copySelection(); return; }
  if (key === 'x' && mod && state.sel.size){ e.preventDefault(); void cutSelection(); return; }
  if (key === 'x' && !mod && state.sel.size){
    e.preventDefault(); toggleCollapseSelection(state.sel); return;
  }
  if (key === 'l' && !mod && state.sel.size){
    e.preventDefault();
    toggleLockSelection();
    return;
  }
  if (key === 'F2' && state.selId){
    e.preventDefault(); startInlineEdit(state.nodes.get(state.selId)); return;
  }
  if (key === 'e' && !mod && state.selId){
    e.preventDefault(); const n = state.nodes.get(state.selId);
    if (n) {
      startBodyEdit(n);
    }
    return;
  }
  if (key === 'Enter' && state.selId){ e.preventDefault(); createSibling(state.selId); return; }
  // Anywhere else Tab stays the browser's: the way to the dock and the bars without a mouse.
  if (key === 'Tab' && !e.shiftKey && state.selId && canOpen(state.nodes.get(state.selId))){
    e.preventDefault();
    addCardInside(state.selId);
    return;
  }
  if (del && state.selEdges.size){ e.preventDefault(); deleteSelectedEdge(); return; }
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
}

function onSpaceUp(e: KeyboardEvent): void {
  if (e.key !== ' ') {
    return;
  }
  const wasPan = ui.spaceUsedForPan;
  ui.spaceHeld = false; ui.spaceUsedForPan = false;
  if (isTypingInField() || wasPan || ui.pan) {
    return;
  }
  // A tap on a lone image card opens it full-screen; the viewer closes on Space too.
  const sole = state.sel.size === 1 && state.selId ? state.nodes.get(state.selId) : null;
  if (sole && isImageCard(sole)) {
    openImageAt(sole, sole.el?.querySelector('img.md-img') ?? null);
  }
}

const editable = (): boolean => store.isOpen;
const hasSel = (): boolean => state.sel.size > 0 && editable();

// Adding or removing a card doesn't apply to a single note (singleNoteRefuses).
const canGrow = (): boolean => editable() && !state.singleNote;
const growSel = (): boolean => hasSel() && !state.singleNote;
const oneSel = (): MindNode | undefined => state.sel.size === 1 && state.selId ? state.nodes.get(state.selId) : undefined;
const plainSectionSelected = (): boolean => nodesOf(selectedIds()).some(n => n.type === 'section' && !isStack(n));

function paletteCommands(): Command[] {
  return [
    { label: 'New card', shortcut: 'N', keywords: 'add create note', when: canGrow, run: newCardAtPointer },
    { label: 'Find…', shortcut: '⌘F', keywords: 'search filter tags card', run: () => openSearch() },
    { label: trayOpen() ? 'Hide the tag tray' : 'Show the tag tray', shortcut: 'T', keywords: 'tags stickers emoji', run: () => toggleTray() },
    { label: 'Undo', shortcut: '⌘Z', when: editable, run: undo },
    { label: 'Redo', shortcut: '⇧⌘Z', when: editable, run: redo },
    { label: state.selId ? 'Focus the selection' : 'Fit the map to the screen', shortcut: 'F', keywords: 'zoom view', run: focusOrFit },
    { label: 'Zoom in', shortcut: '⌘+', run: () => zoomStep(ZOOM_STEP) },
    { label: 'Zoom out', shortcut: '⌘−', run: () => zoomStep(1 / ZOOM_STEP) },
    { label: 'Select all', shortcut: '⌘A', run: selectAll },
    { label: 'Edit', shortcut: 'E', keywords: 'note text write', when: () => editable() && !!oneSel() && oneSel()!.type !== 'section', run: () => startBodyEdit(oneSel()!) },
    { label: 'Rename', shortcut: 'F2', keywords: 'title name', when: () => editable() && oneSel()?.type === 'section', run: () => startInlineEdit(oneSel()) },
    { label: 'Add a card inside the section', shortcut: 'Tab', keywords: 'child', when: () => canGrow() && canOpen(oneSel()), run: () => addCardInside(state.selId!) },
    { label: 'New section', keywords: 'group box section', when: canGrow, run: newSectionAtPointer },
    { label: 'Go to the Inbox', keywords: 'phone capture new notes icloud', when: () => !!inboxSection() || canGrow(), run: goToInbox },
    { label: 'Leave the section', shortcut: '⌘↑', keywords: 'exit back up out parent', when: scopeActive, run: exitScope },
    { label: 'Add a card after', shortcut: 'Enter', keywords: 'sibling', when: () => canGrow() && !!oneSel(), run: () => createSibling(state.selId!) },
    { label: 'Open the section', shortcut: '⌘↓', keywords: 'enter go in', when: () => canEnter(oneSel()), run: () => openSection(oneSel()) },
    { label: 'Connect the selected cards', shortcut: '⌘L', keywords: 'line edge arrow link', when: () => hasSel() && state.sel.size > 1, run: connectSelection },
    { label: 'Wrap in new section', shortcut: '⌘S', keywords: 'group', when: growSel, run: groupSelectionIntoSection },
    { label: 'Resize to fit', shortcut: '⌥⇧⌘R', keywords: 'fit contents auto size shrink grow', when: hasSel, run: autoSizeSelection },
    { label: 'Copy', shortcut: '⌘C', keywords: 'clipboard markdown outline', when: () => state.sel.size > 0, run: () => { void copySelection(); } },
    { label: 'Copy as formatted text', keywords: 'clipboard rich text html styled docs mail word', when: () => state.sel.size > 0, run: () => { void copyFormatted(); } },
    { label: 'Cut', shortcut: '⌘X', keywords: 'clipboard move', when: growSel, run: () => { void cutSelection(); } },
    { label: 'Paste', shortcut: '⌘V', keywords: 'clipboard insert', when: canGrow, run: () => { const p = pointerOrCentre(); void pasteFromClipboard(p.x, p.y, null); } },
    { label: 'Insert image…', keywords: 'picture photo file attach', when: canGrow, run: () => { const p = pointerOrCentre(); pickImagesAt(p.x, p.y, null); } },
    { label: 'Duplicate', shortcut: 'D', keywords: 'copy', when: growSel, run: () => duplicateSelection() },
    { label: 'Duplicate as the next one', shortcut: '⇧D', keywords: 'copy smart series next day date increment log', when: growSel, run: () => duplicateSelection({ next: true }) },
    { label: 'Tag…', shortcut: '#', keywords: 'tags emoji label obsidian', when: () => editable() && taggableSelection().length > 0, run: openTagPicker },
    { label: nodesOf(selectedIds()).some(n => !n.collapsed) ? 'Collapse' : 'Expand', shortcut: 'X', keywords: 'collapse expand fold unfold', when: () => state.sel.size > 0, run: () => toggleCollapseSelection(state.sel) },
    ...TIDY_ACTIONS.map(a => ({ label: a.label, shortcut: a.shortcut || undefined, keywords: 'tidy align arrange distribute layout',
      when: () => state.sel.size >= (a.min ?? 2), run: a.run })),
    { label: 'Tidy up the section', keywords: 'tidy arrange layout grid clean', when: () => state.sel.size === 1 && canTidySection(oneSel()), run: () => tidySection(oneSel()!) },
    { label: 'Collapse all', keywords: 'fold every card section', when: () => foldScope().some(n => !n.collapsed), run: () => setCollapsedSelection(foldScope().map(n => n.id), true) },
    { label: 'Expand all', keywords: 'unfold every card section', when: () => foldScope().some(n => n.collapsed), run: expandAll },
    ...KEY_COLORS.map((c, i) => ({ label: `Colour ${c}`, shortcut: String(i + 1), keywords: 'color fill paint', when: hasSel, run: () => colorSelection(c) })),
    { label: anyLocked(state.sel) ? 'Unlock' : 'Lock', shortcut: 'L', when: hasSel, run: toggleLockSelection },
    // ⌘⌫ is listed once: Unstack when only stacks are selected, else Ungroup, which unstacks them too.
    { label: 'Unstack', shortcut: '⌘⌫', keywords: 'stack pile spread cards out', when: () => hasStackSelected() && !plainSectionSelected(), run: unstackSelection },
    { label: 'Turn into section', keywords: 'stack pile box convert', when: hasStackSelected, run: stackToSection },
    { label: 'Ungroup', shortcut: '⌘⌫', keywords: 'delete section keep cards', when: () => canGrow() && plainSectionSelected(), run: deleteSelectionKeepChildren },
    { label: 'Delete', shortcut: '⌫', keywords: 'remove', when: growSel, run: deleteSelection },
    { label: 'Delete the line', shortcut: '⌫', keywords: 'remove edge arrow', when: () => editable() && state.selEdges.size > 0, run: () => { deleteSelectedEdge(); } },
    { label: 'Copy file path', keywords: 'location folder finder', when: () => !!oneSel()?.file, run: () => copyFilePath(oneSel()!) },
    { label: 'Download as Markdown', keywords: 'export save file md', when: () => state.sel.size > 0, run: exportSelection },
    { label: 'Share…', keywords: 'send airdrop', when: () => canShareFiles && state.sel.size > 0, run: () => { void shareSelection(); } },
    { label: 'Map settings…', keywords: 'canvas colour color background grid dots lines mesh snap', run: openSettings },
    { label: 'Your maps…', keywords: 'home open folder switch', run: showStart },
    { label: 'New map', keywords: 'board create blank', run: () => { void newDeviceMap(); } },
    { label: 'Import .zip…', keywords: 'restore backup upload', run: openImportPicker },
    { label: 'Save now', shortcut: '⌘S', keywords: 'write disk', when: () => store.isOpen && !state.sel.size, run: () => { void flushSave(); } },
    { label: 'Open a note…', keywords: 'file markdown md single card', when: () => 'showOpenFilePicker' in window, run: () => { void pickNote(); } },
    { label: 'Export the map as .zip', keywords: 'backup download', when: () => store.isOpen, run: () => { void exportZip(); } },
    ...(['png', 'pdf'] as ImageFormat[]).map(f => ({
      label: `Export ${state.sel.size ? 'the selection' : 'the map'} as ${f.toUpperCase()}`, keywords: 'picture image download save print share',
      run: () => {
        exportImage(f).catch((e: unknown) => {
          console.error(e);
          setStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      } })),
  ];
}

export function installCommands(): void {
  window.addEventListener('keydown', onShortcutKey);

  // So keyboard and clipboard actions land AT the pointer.
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      ui.lastMouse = { x: e.clientX, y: e.clientY };
    }
  });
  window.addEventListener('keyup', onSpaceUp);
  setPaletteSource(paletteCommands);
  byId('paletteBtn').title = `Actions (${keys('⌘P')})`;
  byId('emptyHintKey').textContent = keys('⌘P');
  byId('paletteBtn').onclick = (e) => {
    e.stopPropagation();
    if (paletteOpen()) {
      closePalette();
    } else {
      openPalette();
    }
  };
}
