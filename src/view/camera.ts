// ---------- view camera: pan / zoom / fit / frame ----------
// Pure camera math over state.view (the {x,y,k} pan+zoom). No painting — callers repaint
// if needed. nodeW/nodeH come from main.js (render) for measuring; isHidden from model.
import { state, world, stage, type MindNode } from '../core/state.js';
import { isHidden } from '../utils/model.js';
import { scopeActive } from '../nav/scope.js';
import { NARROW_MQ } from '../core/ui-state.js';
import { nodeW, nodeH } from '../main.js';
import { scheduleUrlSync } from '../nav/url-state.js';
import { paintGrid } from './grid.js';

// Zoomed out past this, the map is an OVERVIEW: the small chrome hanging off each card — the fold
// chip, the lock badge, the emoji tag row, the "add note" pill — is a handful of unreadable pixels
// there, and there are as many of them as there are cards. So `body.zoom-far` drops the lot
// (styles.css), which also takes their layout and paint work out of every frame of a pinch/pan at the
// zoom level where the most cards are on screen at once. Purely a CSS switch: nothing about a node's
// own geometry depends on it, so crossing the line needs no repaint of the canvas.
export const FAR_ZOOM = 0.5;

// #world carries `will-change:transform` (styles.css) so a pan/pinch is a compositor-only move and
// never repaints the cards. The cost is that Chrome then PINS that layer's raster scale: it keeps
// re-using the texture it already rasterized and simply magnifies it, so zooming in leaves every
// card soft and pixellated at exactly the moment you wanted more detail. (Intermittently — Chrome
// re-rasters on its own often enough that the blur comes and goes, which is what makes it look like
// a fluke.) So once the zoom SETTLES we hand the hint back for two frames: dropping it forces the
// layer to be re-painted at the scale we actually landed on, and restoring it puts the fast path
// back for the next gesture. Only the SCALE needs this — a pan doesn't change the raster scale, so
// panning never gives the hint up and pays nothing. The two rAFs are load-bearing: set and unset
// within one frame and the style change coalesces to a no-op, and no re-raster happens.
const RASTER_SETTLE = 180;
let rasterK = -1, rasterTimer: number | null = null;
function refreshRaster(): void {
  if (state.view.k === rasterK) return;
  rasterK = state.view.k;
  if (rasterTimer) clearTimeout(rasterTimer);
  rasterTimer = window.setTimeout(() => {
    rasterTimer = null;
    world.style.willChange = 'auto';
    requestAnimationFrame(() => requestAnimationFrame(() => { world.style.willChange = ''; }));
  }, RASTER_SETTLE);
}

// Snap the pan to whole DEVICE pixels. `state.view.x/y` are floats — a fit, a glide and a zoom anchor all
// produce fractions — and a fractional translate lands every glyph in the world off the pixel grid. On a
// 2x screen half a CSS pixel IS a whole device pixel, so it costs nothing and nobody notices; on a 1x
// screen it smears each glyph across a pixel boundary and throws away the subpixel (LCD) rendering that
// makes small text look sharp there. That is what "the text looks pixellated on a non-retina screen" is,
// and it is NOT anti-aliasing being off: `-webkit-font-smoothing:antialiased` would make it worse, since
// it replaces subpixel AA with the grayscale kind — thinner and softer at 1x, which is the opposite of
// what's wanted.
// The TRANSFORM is snapped, never `state.view` itself: the model stays exact, so a zoom anchor can't
// drift and screenToWorld keeps its arithmetic — and a disagreement of under half a device pixel between
// hit-testing and paint is invisible by definition. The SCALE is never snapped (that would quantise zoom).
const snapPx = (v: number): number => { const d = window.devicePixelRatio || 1; return Math.round(v * d) / d; };
export function applyView(): void {
  world.style.transform = `translate(${snapPx(state.view.x)}px,${snapPx(state.view.y)}px) scale(${state.view.k})`;
  document.body.classList.toggle('zoom-far', state.view.k < FAR_ZOOM);
  refreshRaster();
  paintGrid();
  scheduleUrlSync();
}
// Smoothly glide the view to (tx,ty) instead of snapping. Any direct pan/zoom cancels it
// (cancelViewAnim) so the animation never fights the user's own input.
let viewAnim: number | null = null;
export function cancelViewAnim(): void { if (viewAnim){ cancelAnimationFrame(viewAnim); viewAnim = null; } }
export function animateViewTo(tx: number, ty: number, tk: number = state.view.k, dur = 420): void {
  cancelViewAnim();
  const sx = state.view.x, sy = state.view.y, sk = state.view.k;
  if (Math.abs(tx-sx) < 1 && Math.abs(ty-sy) < 1 && Math.abs(tk-sk) < .001){
    state.view.x = tx; state.view.y = ty; state.view.k = tk; applyView(); return;
  }
  const t0 = performance.now();
  const ease = (t: number) => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;   // easeInOutCubic
  function step(now: number){
    const p = Math.min(1, (now - t0)/dur), e = ease(p);
    state.view.x = sx + (tx-sx)*e;
    state.view.y = sy + (ty-sy)*e;
    // zoom is perceptually multiplicative, so interpolate k geometrically — with the eased
    // parameter this gives a smooth ease-in/ease-out zoom rather than a linear ramp.
    state.view.k = sk * Math.pow(tk/sk, e);
    applyView();
    viewAnim = p < 1 ? requestAnimationFrame(step) : null;
  }
  viewAnim = requestAnimationFrame(step);
}

export function screenToWorld(sx: number, sy: number): { x: number; y: number } {
  const r = stage.getBoundingClientRect();
  return { x:(sx - r.left - state.view.x)/state.view.k, y:(sy - r.top - state.view.y)/state.view.k };
}

// zoom toward a screen point (mx,my are relative to the stage) by a multiplier
export function zoomAt(mx: number, my: number, factor: number): void {
  cancelViewAnim();
  const k0 = state.view.k;
  const k1 = Math.min(2.5, Math.max(0.2, k0 * factor));
  state.view.x = mx - (mx - state.view.x) * (k1 / k0);
  state.view.y = my - (my - state.view.y) * (k1 / k0);
  state.view.k = k1;
  applyView();
}

// World-space bounding box of every sketch stroke (padded by half each stroke's width), or null
// when the ink layer is empty. Folded into fit()/frameBox so framing never crops a drawing.
export function strokesBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
  for (const s of state.strokes) {
    const hw = s.width / 2;
    for (const [x, y] of s.pts) {
      any = true;
      minX = Math.min(minX, x - hw); minY = Math.min(minY, y - hw);
      maxX = Math.max(maxX, x + hw); maxY = Math.max(maxY, y + hw);
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

// Stage dimensions for camera math. While OUTLINE mode is active #stage is display:none and
// its rect is 0×0 — a fit()/frameBox() run then (e.g. loadFromDir on a boot that restores
// outline mode) would compute k=0 and scale every card away. The stage is position:fixed
// inset:0, so the window size is exactly what its rect would be.
export function stageSize(): { width: number; height: number } {
  const r = stage.getBoundingClientRect();
  return { width: r.width || window.innerWidth, height: r.height || window.innerHeight };
}

export function fit(): void {
  const ns = [...state.nodes.values()].filter(n => !isHidden(n));
  // Ink is map-level data with no parent, so there's no per-stroke scope test to make — while a
  // frame is OPEN it's simply left out of the framing, or fitting the frame's contents would zoom
  // right back out to take in a stroke on the far side of the map. It stays visible; see nav/scope.ts.
  const sb = scopeActive() ? null : strokesBounds();
  if (!ns.length && !sb) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ns) {
    minX = Math.min(minX, n.x);          minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + nodeW(n)); maxY = Math.max(maxY, n.y + nodeH(n));
  }
  if (sb) { minX = Math.min(minX, sb.minX); minY = Math.min(minY, sb.minY); maxX = Math.max(maxX, sb.maxX); maxY = Math.max(maxY, sb.maxY); }
  const r = stageSize();
  const k = Math.min(1.4, Math.min(r.width/(maxX-minX+120), r.height/(maxY-minY+120)));
  state.view.k = k;
  state.view.x = (r.width - (maxX-minX)*k)/2 - minX*k;
  state.view.y = (r.height - (maxY-minY)*k)/2 - minY*k;
  applyView();
}

// How much of the stage's HEIGHT the floating edit bar takes away. On a wide screen it floats
// directly over the selected card and reserves nothing (so no width term is ever needed); on a
// narrow one styles.css docks it along the bottom edge (same 700px breakpoint NARROW_MQ mirrors)
// and it eats height. Every camera move that has to land a node in the VISIBLE canvas subtracts
// this — frameBox and revealInView both — so the two can't disagree about where the bottom is.
function bottomInset(): number {
  const fb = document.getElementById('floatBar') as HTMLElement;
  return (fb.classList.contains('open') && NARROW_MQ.matches) ? fb.offsetHeight : 0;
}

// Zoom + glide so a set of nodes fits, honouring the space the editor sidebar takes from the
// right. Zoom is clamped so we never blow things up huge. Shared by focus-selected and fit-all.
const FOCUS_MIN_K = 0.2, FOCUS_MAX_K = 1.0, FOCUS_PAD = 80;
export function frameBox(nodes: ReadonlyArray<MindNode | undefined>, includeStrokes = false): void {
  const group = nodes.filter((n): n is MindNode => !!n && !isHidden(n));
  const sb = includeStrokes ? strokesBounds() : null;
  if (!group.length && !sb) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of group){
    minX = Math.min(minX, n.x);            minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + nodeW(n));   maxY = Math.max(maxY, n.y + nodeH(n));
  }
  if (sb) { minX = Math.min(minX, sb.minX); minY = Math.min(minY, sb.minY); maxX = Math.max(maxX, sb.maxX); maxY = Math.max(maxY, sb.maxY); }
  const bw = maxX - minX, bh = maxY - minY, cx = (minX+maxX)/2, cy = (minY+maxY)/2;
  const r = stageSize();   // available canvas = stage minus the docked edit bar (bottomInset)
  const availW = r.width;
  const availH = r.height - bottomInset();
  const k = Math.max(FOCUS_MIN_K, Math.min(FOCUS_MAX_K,
    Math.min((availW - 2*FOCUS_PAD) / bw, (availH - 2*FOCUS_PAD) / bh)));
  animateViewTo(availW/2 - cx*k, availH/2 - cy*k, k);   // glide + zoom, never jump
}

// Pan the minimum distance that brings ONE node fully on screen — and nothing more: no zoom
// change, no re-centring, no move at all when it's already visible. That's what arrow-key
// navigation (main.ts) needs and what frameBox is wrong for: walking the tree card by card must
// not re-frame or re-zoom on every step, or the map jumps under you the whole way down a branch.
// The pad keeps the landed card clear of the viewport edge (and of the float bar on a narrow
// screen, which docks along the bottom — hence bottomInset, the same term frameBox subtracts).
const REVEAL_PAD = 60;
// One axis of it: how far to shift so [lo,hi] sits inside [0,limit] with REVEAL_PAD to spare.
// Overshoot on BOTH edges (a card longer than the viewport on this axis) → align its `lo` end, so
// the card's own start is what you see rather than an arbitrary middle. Written once and applied to
// both axes, so a sign slip can't hide on the one that's harder to notice.
function revealShift(lo: number, hi: number, limit: number): number {
  if (lo < REVEAL_PAD) return REVEAL_PAD - lo;
  if (hi > limit - REVEAL_PAD) return Math.max(limit - REVEAL_PAD - hi, REVEAL_PAD - lo);
  return 0;
}
export function revealInView(n: MindNode | undefined): void {
  if (!n || isHidden(n)) return;
  const k = state.view.k, r = stageSize();
  // the node's box in screen space
  const left = n.x*k + state.view.x, top = n.y*k + state.view.y;
  const right = left + nodeW(n)*k, bottom = top + nodeH(n)*k;
  const dx = revealShift(left, right, r.width);
  const dy = revealShift(top, bottom, r.height - bottomInset());
  if (!dx && !dy) return;
  animateViewTo(state.view.x + dx, state.view.y + dy, k, 220);
}
