// ---------- a card's SECTIONS: selecting them, and reordering them by dragging ----------
// A section is the smallest piece of a note the user can point at: one top-level block — a heading, a
// paragraph, a table, a fenced block, a quote, a rule — or, inside a list, ONE ITEM. utils/markdown.ts
// `sections` mirrors renderBodyHTML's walk and hands back the source range behind each of them plus
// the address of the element that draws it, which is what lets a grip sit beside a single bullet.
// Select a single card and every section it holds gets a grip in the left padding column: click one
// to SELECT that section, drag it up or down and the note is rewritten in that order.
//
// A list item is a section for one reason above the others: reordering the lines of a list is most of
// what reordering a note ever means, and a list that could only move as a lump was the one block
// where the gesture had nothing to offer. It costs nothing structural — an item is one line of the
// same text, moved the same way.
//
// Three things this deliberately is NOT:
//
// - It is not a tree. A heading and the paragraphs under it are separate sections, so dragging a
//   heading moves the heading and nothing else. The flat reading is what makes reordering PARAGRAPHS
//   — the thing a note is mostly made of — one drag instead of a selection gesture, and a heading
//   that takes its followers along can be added later as a modifier without changing anything here.
// - It does not touch the TITLE. A card is its text, so the `# ` line renders as the first element of
//   its .body like any other block (main.ts paintNode) — but it wears no grip, is not selectable as a
//   section, and no section can be dropped above it. The reorder therefore rewrites `n.body` alone and
//   can never re-split the note, which is what keeps a drag from silently renaming the file or
//   promoting a `##` to a `#`.
// - It writes NO new state. The order IS the file's own text: one body rewrite, no mm_* key, no
//   board.json entry, nothing that can drift out of step with the note on disk. The SELECTION is the
//   same kind of thing the marquee is — live interaction state, gone when the card is deselected.
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
import { isLockedEffective } from '../utils/model.js';
import { sections, moveSection, type Section } from '../utils/markdown.js';
import { screenToWorld } from '../view/camera.js';
import { scheduleSave } from '../data/persistence.js';
import { record } from './history.js';
import { centredAt, dropCardText, NEW_CARD_H } from './crud.js';
import { textDestAt, showTextDropHint } from './text-drag.js';
import { showLandingGhost, hideLandingGhost } from './drag.js';
import { remeasure, cardMarkdown, NODE_W } from '../main.js';

// ---------- which section is selected ----------
// One at a time, and only ever on the card that is itself selected — the grips exist nowhere else, so
// there is nowhere else to have pointed. Module scope rather than `ui` for the same reason the drag
// below is: nothing outside this file decides it, and the three questions the rest of the app does
// ask (is one selected, clear it, move it) are the exported functions underneath.
interface SecSel { id: string; i: number }
let sel: SecSel | null = null;

// The live gesture. `from`/`to` are indices into the card's SECTIONS (so the title, when it has one,
// is index 0); `off` converts them to body-section indices at commit time.
interface SecDrag {
  n: MindNode;
  els: HTMLElement[];        // the rendered element behind each section, in order
  sec: HTMLElement;          // the element being dragged
  line: HTMLElement;         // the insertion marker
  grip: HTMLElement;
  from: number;
  to: number;
  off: number;               // 1 when the card is titled — the title section wears no grip
  first: number;             // first draggable section index (=== off)
  startY: number;            // clientY at press
  startX: number;
  md: string;                // the note as the grips were built from it — the offsets are into THIS
  rect: DOMRect;             // the source card, which doesn't move: leaving it means "extract"
  out: boolean;              // is the pointer off the card right now?
  moved: boolean;            // did the pointer travel far enough to be a drag rather than a click?
}
let drag: SecDrag | null = null;

// Below this the press is a CLICK (select the section) rather than a drag (move it). In screen px,
// deliberately: it is a property of the hand, not of the zoom.
const DRAG_SLOP = 4;

// Does this card offer section grips at all? Everything here is a reason the gesture would be a lie:
// nothing to reorder, nothing that may be written, or a .body that isn't a rendered note (a folded
// card shows one line, an image card IS its picture, a frame's body is display:none).
function eligible(n: MindNode, collapsed: boolean, editing: boolean): boolean {
  return n.type === 'card' && !collapsed && !editing && !isImageCard(n)
      && state.selId === n.id && state.sel.size <= 1
      && !state.readOnly && !isLockedEffective(n)
      && !document.body.classList.contains('zoom-far');
}

// ---------- resolving a section to the element that draws it ----------
// The guard against `sections` and renderBodyHTML ever drifting apart: every address must land on a
// real element, every rendered child must be spoken for, and a list's items must be as many as its
// `<li>`s. Any disagreement returns null and the card simply shows no grips, rather than moving the
// wrong paragraph.
function sectionEls(bodyEl: HTMLElement, secs: Section[]): HTMLElement[] | null {
  const kids = [...bodyEl.children] as HTMLElement[];
  const els: HTMLElement[] = [];
  const items = new Map<number, number>();     // child -> item count, or -1 for a whole element
  for (const s of secs){
    const k = kids[s.child];
    if (!k) return null;
    if (s.item < 0){
      if (items.has(s.child)) return null;
      items.set(s.child, -1);
      els.push(k);
      continue;
    }
    const li = k.children[s.item] as HTMLElement | undefined;
    if (!li) return null;
    const seen = items.get(s.child) ?? 0;
    if (seen < 0) return null;
    items.set(s.child, seen + 1);
    els.push(li);
  }
  if (items.size !== kids.length) return null;
  for (const [c, n] of items) if (n >= 0 && kids[c].children.length !== n) return null;
  return els;
}

// An element's top inside the card, walking the offsetParent chain rather than reading one offsetTop:
// a `<li>` is a grandchild of .body, and the chain is the only spelling that is right for both depths
// whatever happens to be positioned in between.
function topWithin(el: HTMLElement, root: HTMLElement): number {
  let t = 0;
  for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) t += e.offsetTop;
  return t;
}

// ---------- the grip overlay ----------
// Build (or drop) the grip overlay for one card. Called from paintNode after the body is rendered,
// so it runs per paint — hence the `md`+width cache key: the grips only move when the text they sit
// beside re-wraps. Never rebuilt mid-drag, since the grip holds the pointer capture.
export function syncSectionLayer(n: MindNode, el: HTMLElement, bodyEl: HTMLElement,
                                 md: string, collapsed: boolean, editing: boolean): void {
  const layer = el.querySelector<HTMLElement>(':scope > .sec-layer');
  if (drag && drag.n.id === n.id) return;
  if (!eligible(n, collapsed, editing)) {
    layer?.remove();
    if (sel?.id === n.id) sel = null;      // the grips are gone; so is anything they had selected
    return;
  }
  // Ahead of any measuring or parsing: paintAll runs per animation frame for the length of a drag or
  // a resize, and the grips only move when the text they sit beside re-wraps. (The offsetWidth read
  // is a layout read in a paint loop — affordable only because `eligible` above has already narrowed
  // this to the ONE selected card.)
  const key = md + '|' + Math.round(el.offsetWidth);
  if (layer && layer.dataset.key === key) { markSel(el); return; }
  const off = n.title.trim() ? 1 : 0;
  const secs = sections(md);
  const els = sectionEls(bodyEl, secs);
  if (!els || secs.length - off < 1) { layer?.remove(); sel = null; return; }
  if (sel?.id === n.id && (sel.i < off || sel.i >= secs.length)) sel = null;   // the note shrank under it
  layer?.remove();
  const fresh = document.createElement('div');
  fresh.className = 'sec-layer';
  fresh.dataset.key = key;
  for (let i = off; i < els.length; i++){
    // The element carries its own index too, so the selection highlight can be re-applied without
    // re-parsing the note (markSel below). Wiped whenever paintNode rebuilds the body's HTML — which
    // is exactly when `md` changes, i.e. when this layer is rebuilt anyway.
    els[i].dataset.sec = String(i);
    const grip = document.createElement('div');
    grip.className = 'sec-grip';
    grip.dataset.sec = String(i);
    grip.style.top = topWithin(els[i], el) + 'px';
    grip.style.height = Math.max(10, els[i].offsetHeight - 2) + 'px';
    fresh.append(grip);
  }
  const line = document.createElement('div');
  line.className = 'sec-line';
  fresh.append(line);
  fresh.addEventListener('pointerdown', onGripDown);
  el.append(fresh);
  markSel(el);
}

// Paint the selection onto one card's grips and sections. Class toggles only — no parse, no measure —
// so selecting a section costs nothing and needs no repaint of the map.
function markSel(el: HTMLElement): void {
  const i = sel && sel.id === el.dataset.id ? sel.i : -1;
  el.querySelectorAll<HTMLElement>(':scope > .sec-layer > .sec-grip')
    .forEach(g => g.classList.toggle('sel', +(g.dataset.sec ?? -1) === i));
  el.querySelector<HTMLElement>(':scope > .body')
    ?.querySelectorAll<HTMLElement>('[data-sec]')
    .forEach(s => s.classList.toggle('sec-sel', +(s.dataset.sec ?? -1) === i));
}

// ---------- where a dragged section would land ----------
// Read off the POINTER and nothing else: the first slot whose section starts below the cursor. Which
// is the same thing as saying the cursor is in a section's upper half (it lands above that section),
// in its lower half (below it), or in the gap between two (between them) — one comparison covers all
// three, since the gaps fall either side of a midpoint too. Slots are named by the section index they
// sit ABOVE, so `els.length` means "last", and `first` (the title, on a titled card) is the floor
// nothing can be dropped past.
//
// Deliberately the cursor and not the dragged block's own centre: a tall paragraph dragged by its
// grip has its centre far from the hand holding it, so the landing drifted away from where the user
// was pointing — worst on the blocks that are hardest to aim at. The dragged section is NOT skipped
// here; the slots either side of it are the two no-ops the caller already refuses.
function slotAt(els: HTMLElement[], root: HTMLElement, first: number, y: number): number {
  for (let k = first; k < els.length; k++){
    if (y < topWithin(els[k], root) + els[k].offsetHeight / 2) return k;
  }
  return els.length;
}

function onGripDown(e: PointerEvent): void {
  const grip = (e.target as HTMLElement).closest('.sec-grip') as HTMLElement | null;
  if (!grip || drag) return;
  const el = grip.closest('#world [data-id]') as HTMLElement | null;
  const n = el ? state.nodes.get(el.dataset.id ?? '') : null;
  const body = el?.querySelector<HTMLElement>(':scope > .body');
  const line = grip.parentElement?.querySelector<HTMLElement>('.sec-line');
  if (!n || !el || !body || !line) return;
  // The card's own pointer gestures (drag, marquee, select) must not also see this press — the grip
  // is in NODE_CONTROLS for the double-click side of the same rule.
  e.stopPropagation();
  e.preventDefault();
  const md = cardMarkdown(n);
  const els = sectionEls(body, sections(md));
  const from = +(grip.dataset.sec ?? 0);
  const sec = els?.[from];
  if (!els || !sec) return;
  // The press SELECTS at once, before it is known to be a drag: a click that never moves leaves the
  // section selected (see onGripUp), and a drag wants it selected anyway.
  sel = { id: n.id, i: from };
  markSel(el);
  // Non-fatal: a capture can be refused (the pointer already gone, a synthetic event) and the
  // gesture still works — the listeners below are on the grip either way.
  try { grip.setPointerCapture(e.pointerId); } catch { /* no capture; carry on */ }
  drag = { n, els, sec, line, grip, from, to: from, off: n.title.trim() ? 1 : 0,
           first: n.title.trim() ? 1 : 0, startY: e.clientY, startX: e.clientX,
           md, rect: el.getBoundingClientRect(), out: false, moved: false };
  grip.classList.add('dragging');
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
  // Under the slop this is still a click: nothing lifts, nothing previews, so a tap on a grip to
  // select a bullet doesn't flicker the note out from under the finger.
  if (!d.moved){
    if (Math.abs(e.clientX - d.startX) < DRAG_SLOP && Math.abs(e.clientY - d.startY) < DRAG_SLOP) return;
    d.moved = true;
    d.sec.classList.add('sec-lift');
    document.body.classList.add('sec-dragging');
  }
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
  const root = d.grip.parentElement?.parentElement as HTMLElement;
  // The pointer in the card's own coordinates: topWithin is world px inside .node, clientY is screen.
  d.to = slotAt(d.els, root, d.first, (e.clientY - d.rect.top) / state.view.k);
  const noop = d.to === d.from || d.to === d.from + 1;
  d.line.style.display = noop ? 'none' : 'block';
  if (!noop){
    const last = d.els[d.els.length - 1];
    d.line.style.top = (d.to < d.els.length ? topWithin(d.els[d.to], root)
                                            : topWithin(last, root) + last.offsetHeight) + 'px';
  }
}

// The section's span in `md`, as the character offsets crud.ts TextSource is spelled in.
function rangeOf(md: string, i: number): { start: number; end: number } | null {
  const b = sections(md)[i]; if (!b) return null;
  const lines = md.split('\n');
  let start = 0;
  for (let k = 0; k < b.start; k++) start += lines[k].length + 1;
  let end = start + lines.slice(b.start, b.end).join('\n').length;
  // Take the section's own LINE BREAK with it. Left behind, it is an empty line where the section
  // was: between two paragraphs that is invisible (cutCardText collapses the run anyway), but in the
  // middle of a LIST a blank line is what ENDS one — so extracting a bullet from a list split the
  // list in two behind it. Prefer the break after the section; at the very end of the note there
  // isn't one, so take the break before instead. splitHeading trims, so the text that lands is the
  // same either way.
  if (end < md.length) end++;
  else if (start > 0) start--;
  return { start, end };
}

function onGripUp(e: PointerEvent): void {
  const d = drag; if (!d) return;
  const { n, from, to, off, md, out, moved } = d;
  const at = { x: e.clientX, y: e.clientY };
  finish();
  if (!moved) return;                               // a click: the section stays selected, nothing moves
  if (out){
    const dest = textDestAt(document.elementFromPoint(at.x, at.y), n.id);
    showTextDropHint(null);
    const range = rangeOf(md, from);
    if (!dest || !range) { remeasure(); return; }   // nowhere to put it: the note is left alone
    sel = null;                                     // the section is no longer in this note
    // dropCardText does its own cut, relayout, select, save and history step — the note is one text
    // and this hands it the span, exactly as the selection drag does.
    dropCardText({ id: n.id, ...range },
                 'into' in dest ? dest
                                : { container: dest.container, at: centredAt(screenToWorld(at.x, at.y)) });
    return;
  }
  if (to === from || to === from + 1) return;
  applyMove(n, from, to, off);
}

// The one write both the drag and the keyboard go through: rewrite the body in the new order, keep
// the moved section SELECTED at wherever it ended up (`to` names the slot it was dropped ABOVE, so a
// downward move lands one short of it), and repaint.
function applyMove(n: MindNode, from: number, to: number, off: number): void {
  record([n.id], () => { n.body = moveSection(n.body, from - off, to - off); n.dirty = true; });
  sel = { id: n.id, i: to > from ? to - 1 : to };
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

// ---------- what the rest of the app asks ----------
// Drop the section selection, if there is one. Escape's answer (main.ts) — ahead of clearing the CARD
// selection, so one press steps out of the note and the next out of the card.
export function clearSectionSel(): boolean {
  if (!sel) return false;
  const el = state.nodes.get(sel.id)?.el ?? null;
  sel = null;
  if (el) markSel(el);
  return true;
}

// ⌥↑ / ⌥↓ — move the selected section one place, the keyboard half of the drag. Same write, same
// refusals; the slot arithmetic is the only thing that differs (`to` names the slot ABOVE which the
// section lands, so moving DOWN one place means skipping the neighbour: from + 2).
export function nudgeSection(dir: -1 | 1): boolean {
  if (!sel || sel.id !== state.selId) return false;
  const n = state.nodes.get(sel.id);
  if (!n || state.readOnly || isLockedEffective(n)) return false;
  const secs = sections(cardMarkdown(n));
  const off = n.title.trim() ? 1 : 0;
  const from = sel.i;
  if (from < off || from >= secs.length) return false;
  const to = dir < 0 ? from - 1 : from + 2;
  if (to < off || to > secs.length) return false;
  applyMove(n, from, to, off);
  return true;
}
