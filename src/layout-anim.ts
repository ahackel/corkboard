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

// Newly revealed cards emanate from the nearest ancestor already on screen.
function ancestorStart(node: MindNode, before: Map<string, Pt>): Pt {
  for (const p of ancestors(node)){
    const b = before.get(p.id);
    if (b) {
      return b;
    }
  }
  return { x: node.x, y: node.y };
}

// SVG edges can't transition: redraw them each frame from the gliding cards' computed positions. Only
// line ends and their ancestors are read, since getComputedStyle is the cost.
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
      return;                  // superseded
    }
    const saved: Array<[MindNode, number, number]> = [];
    for (const n of ends){
      if (!n.el || isHidden(n)) {
        continue;
      }
      const c = getComputedStyle(n.el);
      saved.push([n, n.x, n.y]);
      // A hosted card's left/top are relative to its section's interior.
      const host = settledHost(n);
      const o = host ? sectionInterior(host) : null;
      const px = parseFloat(c.left), py = parseFloat(c.top);
      n.x = px ? (o ? px + o.x : px) : n.x;
      n.y = py ? (o ? py + o.y : py) : n.y;
    }
    paintFreeEdges();
    for (const [n,x,y] of saved){ n.x = x; n.y = y; }
    if (now - t0 < ms) {
      requestAnimationFrame(tick);
    } else {
      paintFreeEdges();
    }
  };
  requestAnimationFrame(tick);
}

// Take it BEFORE the structural change.
export function layoutSnapshot(): Map<string, Pt> {
  const before = new Map<string, Pt>();
  for (const m of state.nodes.values()) {
    if (m.el && !isHidden(m)) {
      before.set(m.id, { x:m.x, y:m.y });
    }
  }
  return before;
}

export function animateLayout(mutate: () => void): void {
  const before = layoutSnapshot();
  const sizes = sizeSnapshot();
  mutate();
  paintAll();
  applyLayouts();
  animateReflow(before);
  animateSizes(sizes);
}

// Sizes glide with the Web Animations API, which hands width/height back when done.
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

// Even, not a sharp ease-out: that made a fold read as instant.
const SIZE_EASE = 'cubic-bezier(.45,0,.25,1)';

// Must match `.lt-anim`'s transition in styles.css.
export const LAYOUT_ANIM_MS = MOTION ? 500 : 0;

function animateSizes(before: Map<HTMLElement, Size>): void {
  // A just-unfolded section had no wrapper to snapshot: start it as small as the pill it grows out of.
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

export function animateReflow(before: Map<string, Pt>): void {
  const visible = [...state.nodes.values()].filter(m => m.el && !isHidden(m));
  const tok = ++ui.animToken;                           // supersede any in-flight animation
  // Ports and resize handles stand down meanwhile: they'd sit at stale spots.
  document.body.classList.add('layout-anim');
  // A card that didn't move within its moving section rides along with it rather than gliding.
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
  // A section's clip wrapper is its box's SIBLING, so it must glide alongside or its cards hang outside.
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
  const DUR = LAYOUT_ANIM_MS;
  for (const m of visible){
    if (!stays(m)) {
      m.el!.classList.add('lt-anim');
    }
    placeSelf(m, m.x, m.y);
    m.el!.style.opacity = '';
  }
  for (const [w, left, top] of clips){ w.classList.add('lt-anim'); w.style.left = left; w.style.top = top; }
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

