// ---------- reordering a card's SECTIONS by dragging them ----------
// A section is one top-level block of the note — a heading, a paragraph, a list, a table, a fenced
// block, a quote, a rule — i.e. exactly what renderBodyHTML emits one element for, which is why
// utils/markdown.ts `blocks` mirrors that walk and hands back the source range behind each of them.
// Select a single card and every section it holds gets a grip in the left padding column; drag one
// up or down and the note is rewritten in that order.
//
// Three things this deliberately is NOT:
//
// - It is not a tree. A heading and the paragraphs under it are separate sections, so dragging a
//   heading moves the heading and nothing else. The flat reading is what makes reordering PARAGRAPHS
//   — the thing a note is mostly made of — one drag instead of a selection gesture, and a heading
//   that takes its followers along can be added later as a modifier without changing anything here.
// - It does not touch the TITLE. A card is its text, so the `# ` line renders as the first element of
//   its .body like any other block (main.ts paintNode) — but it wears no grip, and no section can be
//   dropped above it. The reorder therefore rewrites `n.body` alone and can never re-split the note,
//   which is what keeps a drag from silently renaming the file or promoting a `##` to a `#`.
// - It writes NO new state. The order IS the file's own text: one body rewrite, no mm_* key, no
//   board.json entry, nothing that can drift out of step with the note on disk.
//
// Dragging a grip OFF the card is the same gesture's other half: the section leaves the note and
// becomes a card of its own where it was dropped — or joins the card it was dropped on. That landing
// is not decided here. features/text-drag.ts already answers "what does dropping text there mean"
// for the selection-drag, and crud.ts dropCardText owns every one of those landings, so this reuses
// both; the two gestures differ only in how they PICK the text.
//
// Pointer-driven rather than the browser's native text drag, so unlike dragging a selection out of a
// card this works on touch.
import { state, isImageCard, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { isLockedEffective } from '../utils/model.js';
import { blocks, moveBlock } from '../utils/markdown.js';
import { screenToWorld } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { record } from './history.js';
import { centredAt, dropCardText, NEW_CARD_H } from './crud.js';
import { textDestAt, showTextDropHint } from './text-drag.js';
import { showLandingGhost, hideLandingGhost } from './drag.js';
import { remeasure, cardMarkdown, NODE_W } from '../main.js';

// The live gesture. `from`/`to` are indices into the card's RENDERED children (so the title, when it
// has one, is index 0); `off` converts them to body-block indices at commit time.
interface SecDrag {
  n: MindNode;
  body: HTMLElement;
  sec: HTMLElement;          // the element being dragged
  line: HTMLElement;         // the insertion marker
  grip: HTMLElement;
  from: number;
  to: number;
  off: number;               // 1 when the card is titled — the title element wears no grip
  first: number;             // first draggable child index (=== off)
  startY: number;            // clientY at press
  startX: number;
  md: string;                // the note as the grips were built from it — the offsets are into THIS
  rect: DOMRect;             // the source card, which doesn't move: leaving it means "extract"
  out: boolean;              // is the pointer off the card right now?
}
let drag: SecDrag | null = null;

// Does this card offer section grips at all? Everything here is a reason the gesture would be a lie:
// nothing to reorder, nothing that may be written, or a .body that isn't a rendered note (a folded
// card shows one line, an image card IS its picture, a frame's body is display:none).
function eligible(n: MindNode, collapsed: boolean, editing: boolean): boolean {
  return n.type === 'card' && !collapsed && !editing && !isImageCard(n)
      && state.selId === n.id && state.sel.size <= 1
      && !state.readOnly && !isLockedEffective(n)
      && !document.body.classList.contains('zoom-far');
}

// Build (or drop) the grip overlay for one card. Called from paintNode after the body is rendered,
// so it runs per paint — hence the `md`+width cache key: the grips only move when the text they sit
// beside re-wraps. Never rebuilt mid-drag, since the grip holds the pointer capture.
export function syncSectionLayer(n: MindNode, el: HTMLElement, bodyEl: HTMLElement,
                                 md: string, collapsed: boolean, editing: boolean): void {
  const layer = el.querySelector<HTMLElement>(':scope > .sec-layer');
  if (drag && drag.n.id === n.id) return;
  if (!eligible(n, collapsed, editing)) { layer?.remove(); return; }
  // Ahead of any measuring or parsing: paintAll runs per animation frame for the length of a drag or
  // a resize, and the grips only move when the text they sit beside re-wraps. (The offsetWidth read
  // is a layout read in a paint loop — affordable only because `eligible` above has already narrowed
  // this to the ONE selected card.)
  const key = md + '|' + Math.round(el.offsetWidth);
  if (layer && layer.dataset.key === key) return;
  const off = n.title.trim() ? 1 : 0;
  const kids = [...bodyEl.children] as HTMLElement[];
  // The count check is the guard against `blocks` and renderBodyHTML ever drifting apart: if the two
  // walks disagree the card simply shows no grips, rather than moving the wrong paragraph.
  if (blocks(md).length !== kids.length || kids.length - off < 1) { layer?.remove(); return; }
  layer?.remove();
  const fresh = document.createElement('div');
  fresh.className = 'sec-layer';
  fresh.dataset.key = key;
  for (let i = off; i < kids.length; i++){
    const grip = document.createElement('div');
    grip.className = 'sec-grip';
    grip.dataset.sec = String(i);
    grip.style.top = kids[i].offsetTop + 'px';
    grip.style.height = Math.max(10, kids[i].offsetHeight - 2) + 'px';
    fresh.append(grip);
  }
  const line = document.createElement('div');
  line.className = 'sec-line';
  fresh.append(line);
  fresh.addEventListener('pointerdown', onGripDown);
  el.append(fresh);
}

// Where a section would land, read off the POINTER and nothing else: the first slot whose section
// starts below the cursor. Which is the same thing as saying the cursor is in a section's upper half
// (it lands above that section), in its lower half (below it), or in the gap between two (between
// them) — one comparison covers all three, since the gaps fall either side of a midpoint too.
// Slots are named by the child index they sit ABOVE, so `kids.length` means "last", and `first`
// (the title, on a titled card) is the floor nothing can be dropped past.
//
// Deliberately the cursor and not the dragged block's own centre: a tall paragraph dragged by its
// grip has its centre far from the hand holding it, so the landing drifted away from where the user
// was pointing — worst on the blocks that are hardest to aim at. The dragged section is NOT skipped
// here; the slots either side of it are the two no-ops the caller already refuses.
function slotAt(kids: HTMLElement[], first: number, y: number): number {
  for (let k = first; k < kids.length; k++){
    if (y < kids[k].offsetTop + kids[k].offsetHeight / 2) return k;
  }
  return kids.length;
}

function onGripDown(e: PointerEvent): void {
  const grip = (e.target as HTMLElement).closest('.sec-grip') as HTMLElement | null;
  if (!grip || drag) return;
  const el = grip.closest('#world [data-id]') as HTMLElement | null;
  const n = el ? state.nodes.get(el.dataset.id ?? '') : null;
  const body = el?.querySelector<HTMLElement>(':scope > .body');
  const line = grip.parentElement?.querySelector<HTMLElement>('.sec-line');
  if (!n || !body || !line) return;
  // The card's own pointer gestures (drag, marquee, select) must not also see this press — the grip
  // is in NODE_CONTROLS for the double-click side of the same rule.
  e.stopPropagation();
  e.preventDefault();
  const from = +(grip.dataset.sec ?? 0);
  const sec = body.children[from] as HTMLElement | undefined;
  if (!sec) return;
  // Non-fatal: a capture can be refused (the pointer already gone, a synthetic event) and the
  // gesture still works — the listeners below are on the grip either way.
  try { grip.setPointerCapture(e.pointerId); } catch { /* no capture; carry on */ }
  drag = { n, body, sec, line, grip, from, to: from, off: n.title.trim() ? 1 : 0,
           first: n.title.trim() ? 1 : 0, startY: e.clientY, startX: e.clientX,
           md: cardMarkdown(n), rect: (el as HTMLElement).getBoundingClientRect(), out: false };
  sec.classList.add('sec-lift');
  grip.classList.add('dragging');
  document.body.classList.add('sec-dragging');
  grip.addEventListener('pointermove', onGripMove);
  grip.addEventListener('pointerup', onGripUp);
  grip.addEventListener('pointercancel', abort);
  window.addEventListener('keydown', onKey, true);
}

function onGripMove(e: PointerEvent): void {
  const d = drag; if (!d) return;
  // clientY is screen space and the card lives inside the scaled #world, so the offset the section
  // travels is the pointer's divided by the zoom — the same conversion features/drag.ts makes.
  const dx = (e.clientX - d.startX) / state.view.k;
  const dy = (e.clientY - d.startY) / state.view.k;
  d.sec.style.transform = `translate(${dx}px, ${dy}px)`;
  // ONE test tells the two halves apart: still over the card it came from = reorder, off it =
  // extract. No threshold and no modifier — the card's own edge is the line, which is the same thing
  // the eye reads while the paragraph is being pulled out of it.
  const r = d.rect;
  d.out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  if (d.out){
    d.line.style.display = 'none';
    // The lifted section is pointer-events:none (styles.css), so what's UNDER the cursor is the card
    // or container being aimed at rather than the text being dragged.
    const dest = textDestAt(document.elementFromPoint(e.clientX, e.clientY), d.n.id);
    showTextDropHint(dest);
    // …and where it lands, in the SAME phantom card a dragged node previews with (features/drag.ts).
    // Only when a card is what comes out of it: a drop INTO another note appends text rather than
    // making anything, and its dashed outline already says so.
    if (dest && !('into' in dest)){
      const at = centredAt(screenToWorld(e.clientX, e.clientY));
      showLandingGhost(at.x, at.y, NODE_W, NEW_CARD_H);
    } else hideLandingGhost();
    return;
  }
  showTextDropHint(null);
  hideLandingGhost();   // back over the card: this is a reorder again
  const kids = [...d.body.children] as HTMLElement[];
  // The pointer in the card's own coordinates: offsetTop is world px inside .node, clientY is screen.
  d.to = slotAt(kids, d.first, (e.clientY - d.rect.top) / state.view.k);
  const noop = d.to === d.from || d.to === d.from + 1;
  d.line.style.display = noop ? 'none' : 'block';
  if (!noop){
    const last = kids[kids.length - 1];
    d.line.style.top = (d.to < kids.length ? kids[d.to].offsetTop
                                           : last.offsetTop + last.offsetHeight) + 'px';
  }
}

// The dragged block's span in `md`, as the character offsets crud.ts TextSource is spelled in.
function rangeOf(md: string, i: number): { start: number; end: number } | null {
  const b = blocks(md)[i]; if (!b) return null;
  const lines = md.split('\n');
  let start = 0;
  for (let k = 0; k < b.start; k++) start += lines[k].length + 1;
  return { start, end: start + lines.slice(b.start, b.end).join('\n').length };
}

function onGripUp(e: PointerEvent): void {
  const d = drag; if (!d) return;
  const { n, from, to, off, md, out } = d;
  const at = { x: e.clientX, y: e.clientY };
  finish();
  if (out){
    const dest = textDestAt(document.elementFromPoint(at.x, at.y), n.id);
    showTextDropHint(null);
    const range = rangeOf(md, from);
    if (!dest || !range) { remeasure(); return; }   // nowhere to put it: the note is left alone
    // dropCardText does its own cut, relayout, select, save and history step — the note is one text
    // and this hands it the span, exactly as the selection drag does.
    dropCardText({ id: n.id, ...range },
                 'into' in dest ? dest
                                : { container: dest.container, at: centredAt(screenToWorld(at.x, at.y)) });
    return;
  }
  if (to === from || to === from + 1) return;
  record([n.id], () => { n.body = moveBlock(n.body, from - off, to - off); n.dirty = true; });
  remeasure();     // the note re-renders at a new height; the overlay is rebuilt with it
  scheduleSave();
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !drag) return;
  e.preventDefault();
  e.stopPropagation();
  abort();
}

function abort(): void {
  const n = drag?.n;
  finish();
  if (n) remeasure();   // put the lifted section back where it was
}

// Tear the gesture down without deciding anything — both endings go through here.
function finish(): void {
  const d = drag; if (!d) return;
  drag = null;
  d.sec.style.transform = '';
  d.sec.classList.remove('sec-lift');
  d.grip.classList.remove('dragging');
  d.line.style.display = 'none';
  document.body.classList.remove('sec-dragging');
  showTextDropHint(null);
  hideLandingGhost();
  d.grip.removeEventListener('pointermove', onGripMove);
  d.grip.removeEventListener('pointerup', onGripUp);
  d.grip.removeEventListener('pointercancel', abort);
  window.removeEventListener('keydown', onKey, true);
}

// Is a section drag running on this node? paintNode asks before it would rebuild the .body's HTML.
export function sectionDragging(id: string): boolean { return drag?.n.id === id; }
