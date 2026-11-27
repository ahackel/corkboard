// Dragging selected text OUT of a card's editor: onto a card appends it, elsewhere it becomes a card; a MOVE.
// Rides the browser's NATIVE textarea drag, so it is desktop-only (⌘⇧E extracts on iPad).
import { state, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { isLockedEffective, nodeAtTarget, takesDrop } from '../utils/model.js';
import { isSection } from '../view/layout.js';
import { screenToWorld } from '../view/camera.js';
import { centredAt, dropCardText, cardText,
         type TextSource } from './crud.js';
import { firstLineSplit } from '../utils/frontmatter.js';
import { effectiveColor } from '../render.js';
import { classMarker } from '../utils/dom.js';
import { colorClass, applyColorVars } from '../view/color.js';
import { NODE_W } from '../view/geometry.js';

// Captured at dragstart: by drop time the editor may have lost the selection.
let pending: TextSource | null = null;

// `null` leaves the browser its native behaviour: a drag back into its own note stays an in-textarea move.
type Dest = { into: MindNode } | { container: MindNode | null };

function destAt(t: EventTarget | null, sourceId: string): Dest | null {
  const n = nodeAtTarget(t);
  if (n?.id === sourceId || (n && isLockedEffective(n))) {
    return null;
  }
  if (n && takesDrop(n)) {
    return { into: n };
  }
  if (n && isSection(n)) {
    return { container: n };
  }

  // The canvas, or what can't take text or hold a card (an image card, a folded section).
  return { container: null };
}

const markMerge = classMarker('drop-merge');
const markSection = classMarker('drop-target');

function showHint(dest: Dest | null): void {
  markMerge(dest && 'into' in dest ? dest.into.el ?? null : null);
  markSection(dest && 'container' in dest ? dest.container?.el ?? null : null);
}

// A range of the open editor on the card the drag began on. Shared with the card's own export dragstart
// (features/clipboard.ts), which must stand aside for exactly this gesture and no other.
export function cardTextDrag(target: EventTarget | null): TextSource | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const be = ui.bodyEdit;
  if (!be || be.ta.selectionStart === be.ta.selectionEnd) {
    return null;
  }
  const n = state.nodes.get(be.id);
  if (!n || !n.el || isLockedEffective(n) || !n.el.contains(target)) {
    return null;
  }
  return { id: be.id, start: be.ta.selectionStart, end: be.ta.selectionEnd };
}

// The drag image is a CARD in the source's colour. The browser snapshots it during dragstart, so it must be
// rendered (display:none snapshots as nothing) and is removed only on the next tick.
function buildGhost(source: MindNode, text: string): HTMLElement {
  const col = effectiveColor(source);
  const el = document.createElement('div');
  el.className = 'node drag-ghost ' + colorClass(col);
  applyColorVars(el, col);
  el.style.width = NODE_W + 'px';
  const { title, body } = firstLineSplit(text);
  const row = document.createElement('div'); row.className = 'title-row';
  const t = document.createElement('div'); t.className = 'title';
  t.textContent = title || 'New Card';
  row.appendChild(t); el.appendChild(row);
  if (body){
    const b = document.createElement('div'); b.className = 'body';
    b.textContent = body;
    el.appendChild(b);
  }
  document.body.appendChild(el);
  return el;
}

// Near the ghost's title, as if held by it.
const GHOST_GRIP = { x: 28, y: 22 };

export function installTextDrag(): void {
  // The drag DATA is left to the browser: its text/plain lets the text drop into another app.
  document.addEventListener('dragstart', (e) => {
    pending = cardTextDrag(e.target);
    if (!pending) {
      return;
    }
    const source = state.nodes.get(pending.id);
    const text = cardText(pending);
    if (!e.dataTransfer || !source || !text) {
      return;
    }
    const ghost = buildGhost(source, text);
    e.dataTransfer.setDragImage(ghost, GHOST_GRIP.x, GHOST_GRIP.y);
    setTimeout(() => ghost.remove(), 0);
  });
  document.addEventListener('dragover', (e) => {
    if (!pending) {
      return;
    }
    const dest = destAt(e.target, pending.id);
    showHint(dest);
    if (!dest) {
      return;              // the browser keeps the drop
    }
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  });
  document.addEventListener('drop', (e) => {
    const p = pending;
    if (!p) {
      return;
    }
    pending = null;
    const dest = destAt(e.target, p.id);
    showHint(null);
    if (!dest) {
      return;
    }
    e.preventDefault();
    dropCardText(p,
      'into' in dest ? dest : { container: dest.container, at: centredAt(screenToWorld(e.clientX, e.clientY)) });
  });
  document.addEventListener('dragend', () => { pending = null; showHint(null); });
}
