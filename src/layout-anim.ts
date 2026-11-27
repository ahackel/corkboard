// The animated relayout: a fold, a Fit or a tidy-up glides every card from where it stood to where it lands.

import { MOTION } from './utils/motion.js';
import { isHidden, parentOf, ancestors } from './utils/model.js';
import { state, isStack, type MindNode } from './core/state.js';
import { applyLayouts, sectionInterior } from './view/layout.js';
import { paintFreeEdges } from './view/free-edges.js';
import { isScopeRoot } from './nav/scope.js';
import { ui, type Pt } from './core/ui-state.js';
import { syncSelFrame } from './features/sel-frame.js';
import { paintAll, placeSelf, settledHost } from './render.js';

// Every glide plays whatever the system's "Reduce motion" says: the motion IS how a fold or a fan reads.
// Glides write left/top through placeSelf, so a hosted card stays in its section's wrapper meanwhile.
// Newly revealed cards emanate from the nearest ancestor that was already on screen.
function ancestorStart(node: MindNode, before: Map<string, Pt>): Pt {
  for (const p of ancestors(node)){
    const b = before.get(p.id);
    if (b) {
      return b;
    }
  }
  return { x: node.x, y: node.y };
}

// Cards glide to new spots via a CSS transition; SVG edges can't transition, so for the duration
// we redraw them each section from the cards' live (animating) on-screen positions.
// Only a line's END cards (and the sections around them, which a hidden end is drawn to) are read: the
// computed-style read is the cost, and there are far fewer of those than cards. No lines, no loop.
function followEdges(tok: number, ms: number): void {
  if (!state.edges.length) {
    return;
  }
  const ends = new Set<MindNode>();
  for (const e of state.edges) {
    for (const id of [e.from, e.to]) {
      const n = state.nodes.get(id);
      if (!n) {
        continue;
      }
      ends.add(n);
      for (const a of ancestors(n)) {
        ends.add(a);
      }
    }
  }
  const t0 = performance.now();
  const tick = (now: number): void => {
    if (tok !== ui.animToken) {
      return;                  // superseded by a newer animation
    }
    const saved: Array<[MindNode, number, number]> = [];
    for (const n of ends){
      if (!n.el || isHidden(n)) {
        continue;
      }
      const c = getComputedStyle(n.el);             // interpolated left/top while transitioning
      saved.push([n, n.x, n.y]);
      // left/top are HOST-relative for a hosted card — project back to absolute world coords, through
      // the same origin place() measured them from (contentOrigin, on its no-drag basis).
      const host = settledHost(n);
      const o = host ? sectionInterior(host) : null;
      const px = parseFloat(c.left), py = parseFloat(c.top);
      n.x = px ? (o ? px + o.x : px) : n.x;
      n.y = py ? (o ? py + o.y : py) : n.y;
    }
    paintFreeEdges();
    for (const [n,x,y] of saved){ n.x = x; n.y = y; }   // restore logical (final) positions
    if (now - t0 < ms) {
      requestAnimationFrame(tick);
    } else {
      paintFreeEdges();
    }
  };
  requestAnimationFrame(tick);
}

// Snapshot the on-screen position of every visible card — the START section animateReflow
// glides away from. Take it BEFORE the structural change.
export function layoutSnapshot(): Map<string, Pt> {
  const before = new Map<string, Pt>();
  for (const m of state.nodes.values()) {
    if (m.el && !isHidden(m)) {
      before.set(m.id, { x:m.x, y:m.y });
    }
  }
  return before;
}

// Run a structural change (a collapse toggle, a tidy-up) and CSS-animate the resulting reflow.
export function animateLayout(mutate: () => void): void {
  const before = layoutSnapshot();
  const sizes = sizeSnapshot();
  mutate();
  paintAll();          // reveal/hide DOM and measure real heights
  applyLayouts();      // compute FINAL positions into n.x/n.y (DOM not updated yet)
  animateReflow(before);
  animateSizes(sizes);
}

// The SIZES glide too (a fold, a Fit): each changed element plays from its old box to its new one with the
// Web Animations API, which hands width/height back when done. Content is clipped meanwhile.
interface Size { w: number; h: number }

function sizeSnapshot(): Map<HTMLElement, Size> {
  const out = new Map<HTMLElement, Size>();
  for (const m of state.nodes.values()) {
    if (!m.el || isHidden(m)) {
      continue;
    }
    out.set(m.el, { w: m.el.offsetWidth, h: m.el.offsetHeight });
    if (m.sectionContentEl) {
      out.set(m.sectionContentEl, { w: m.sectionContentEl.offsetWidth, h: m.sectionContentEl.offsetHeight });
    }
  }
  return out;
}

// An even ease-in-out, not a sharp ease-out: the old (.22,1,.36,1) did 75% of the move in the first fifth
// of the time, so a fold read as instant however long it nominally ran.
const SIZE_EASE = 'cubic-bezier(.45,0,.25,1)';

// How long a fold / Fit / reflow glides — one number for the sizes here, the positions (animateReflow) and
// `.lt-anim`'s left/top transition in styles.css, which must say the same.
export const LAYOUT_ANIM_MS = MOTION ? 500 : 0;

function animateSizes(before: Map<HTMLElement, Size>): void {
  // A section that has just UNFOLDED had no content wrapper to snapshot: it starts as small as the box
  // it grows out of (the pill, less the box's own border), so its cards stay clipped all the way open.
  for (const m of state.nodes.values()) {
    const w = m.sectionContentEl, a = m.el ? before.get(m.el) : undefined;
    if (!w || !a || before.has(w) || !m.el) {
      continue;
    }
    before.set(w, { w: Math.max(0, a.w - (m.el.offsetWidth - w.offsetWidth)), h: Math.max(0, a.h - (m.el.offsetHeight - w.offsetHeight)) });
  }
  for (const [el, a] of before) {
    if (!el.isConnected || el.style.display === 'none') {
      continue;
    }
    const b = { w: el.offsetWidth, h: el.offsetHeight };
    if (Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1) {
      continue;
    }
    el.animate([
      { width: a.w + 'px', height: a.h + 'px', minHeight: '0px', maxWidth: 'none', overflow: 'hidden' },
      { width: b.w + 'px', height: b.h + 'px', minHeight: '0px', maxWidth: 'none', overflow: 'hidden' },
    ], { duration: LAYOUT_ANIM_MS, easing: SIZE_EASE });
  }
}

// Glide every visible card from its `before` spot to its final n.x/n.y; just-revealed ones fade in from
// their nearest ancestor.
export function animateReflow(before: Map<string, Pt>): void {
  const visible = [...state.nodes.values()].filter(m => m.el && !isHidden(m));
  const tok = ++ui.animToken;                           // supersede any in-flight animation
  // While cards glide and change size (this and animateSizes), the ports and resize handles would sit at
  // stale spots and sizes: they stand down until the glide ends (styles.css body.layout-anim).
  document.body.classList.add('layout-anim');
  // 1) park every visible card at its STARTING spot, no transition; just-revealed ones start invisible. A card
  //    inside a section that itself changed rides along with it; only one that moved WITHIN it (a tidy-up, a
  //    stack fanning out) glides.
  const stays = (m: MindNode): boolean => {
    const p = parentOf(m);
    if (!p || isScopeRoot(p)) {
      return false;
    }
    const bm = before.get(m.id), bp = before.get(p.id);
    if (!bm) {
      return !isStack(p);
    }
    return !!bp && Math.abs((bm.x - bp.x) - (m.x - p.x)) < 0.5 && Math.abs((bm.y - bp.y) - (m.y - p.y)) < 0.5;
  };
  // A section's content wrapper (its CLIP) is a sibling of its box, not inside it, so it glides alongside:
  // parked at the same offset from its final spot as the box, then sent home with the same transition.
  // Otherwise the box would glide while the clip jumped, and the cards would hang outside it meanwhile.
  const clips: Array<[HTMLElement, string, string]> = [];
  for (const m of visible){
    m.el!.classList.remove('lt-anim');
    const s = stays(m) ? { x: m.x, y: m.y } : before.get(m.id) || ancestorStart(m, before);
    placeSelf(m, s.x, s.y);
    if (!before.has(m.id)) {
      m.el!.style.opacity = '0';
    }
    const w = m.sectionContentEl;
    if (w?.isConnected && (s.x !== m.x || s.y !== m.y)) {
      w.classList.remove('lt-anim');
      clips.push([w, w.style.left, w.style.top]);
      w.style.left = (parseFloat(w.style.left) + s.x - m.x) + 'px';
      w.style.top  = (parseFloat(w.style.top)  + s.y - m.y) + 'px';
    }
  }
  void document.body.offsetWidth;                    // commit the start positions before transitioning
  // 2) turn on the transition and move every card to its FINAL spot → the browser animates left/top
  const DUR = LAYOUT_ANIM_MS;
  for (const m of visible){
    if (!stays(m)) {
      m.el!.classList.add('lt-anim');
    }
    placeSelf(m, m.x, m.y);
    m.el!.style.opacity = '';
  }
  for (const [w, left, top] of clips){ w.classList.add('lt-anim'); w.style.left = left; w.style.top = top; }
  // 3) edges follow the moving cards; drop the transition class once it's done
  followEdges(tok, DUR + 20);
  setTimeout(() => {
    if (tok !== ui.animToken) {
      return;
    }
    for (const m of visible) {
      m.el && m.el.classList.remove('lt-anim');
    }
    for (const [w] of clips) {
      w.classList.remove('lt-anim');
    }
    document.body.classList.remove('layout-anim');
    paintFreeEdges();
    syncSelFrame();
  }, DUR + 60);
}

