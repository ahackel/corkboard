// Pan, zoom, fit and frame over state.view. No painting: callers repaint if needed.
import { state, world, stage, type MindNode } from '../core/state.js';
import { isHidden } from '../utils/model.js';
import { NARROW_MQ } from '../core/ui-state.js';
import { paintGrid } from './grid.js';
import { byId } from '../utils/dom.js';
import { clamp } from '../utils/num.js';
import { nodeW, nodeH } from './geometry.js';
import { MOTION } from '../utils/motion.js';

// Below this `body.zoom-far` drops each card's small chrome (CSS only: crossing it needs no repaint).
const FAR_ZOOM = 0.5;
const MIN_ZOOM = 0.2, MAX_ZOOM = 2.5;

// Chrome pins a `will-change:transform` layer's raster scale, so zooming in leaves cards blurry. Once
// the zoom settles, drop the hint for two frames to force a re-raster (within one frame it coalesces away).
const RASTER_SETTLE = 180;
let rasterK = -1, rasterTimer: number | null = null;
function refreshRaster(): void {
  if (state.view.k === rasterK) {
    return;
  }
  rasterK = state.view.k;
  if (rasterTimer) {
    clearTimeout(rasterTimer);
  }
  rasterTimer = window.setTimeout(() => {
    rasterTimer = null;
    world.style.willChange = 'auto';
    requestAnimationFrame(() => requestAnimationFrame(() => { world.style.willChange = ''; }));
  }, RASTER_SETTLE);
}

// A fractional pan blurs text on a 1x screen. Only the transform is snapped; state.view stays exact.
const snapPx = (v: number): number => { const d = window.devicePixelRatio || 1; return Math.round(v * d) / d; };
// Zoomed out, a section's name keeps its screen size. Set per section, not on #world: a custom property
// there would restyle every card on every zoom frame.
export const labelScale = (): number => Math.max(1, 1 / state.view.k);
let paintedLs = 1;
function applyLabelScale(): void {
  const ls = labelScale();
  if (ls === paintedLs) {
    return;
  }
  paintedLs = ls;
  for (const n of state.nodes.values()) {
    if (n.type === 'section') {
      n.el?.style.setProperty('--ls', String(ls));
    }
  }
}
let viewApplied: () => void = () => {};

export function onViewApplied(listener: () => void): void {
  viewApplied = listener;
}

export function applyView(): void {
  world.style.transform = `translate(${snapPx(state.view.x)}px,${snapPx(state.view.y)}px) scale(${state.view.k})`;
  document.body.classList.toggle('zoom-far', state.view.k < FAR_ZOOM);
  applyLabelScale();
  refreshRaster();
  paintGrid();
  viewApplied();
}
// Any direct pan/zoom cancels a glide, so it never fights the user's input.
let viewAnim: number | null = null;
export function cancelViewAnim(): void { if (viewAnim){ cancelAnimationFrame(viewAnim); viewAnim = null; } }
const GLIDE_MS = 420;
export function jumpViewTo(tx: number, ty: number, tk: number = state.view.k): void {
  cancelViewAnim();
  state.view.x = tx; state.view.y = ty; state.view.k = tk;
  applyView();
}

export function animateViewTo(tx: number, ty: number, tk: number = state.view.k): void {
  if (!MOTION) {
    jumpViewTo(tx, ty, tk);
    return;
  }
  cancelViewAnim();
  const sx = state.view.x, sy = state.view.y, sk = state.view.k;
  if (Math.abs(tx-sx) < 1 && Math.abs(ty-sy) < 1 && Math.abs(tk-sk) < .001){
    state.view.x = tx; state.view.y = ty; state.view.k = tk; applyView(); return;
  }
  const t0 = performance.now();
  const ease = (t: number) => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3)/2;   // easeInOutCubic
  function step(now: number){
    const p = Math.min(1, (now - t0)/GLIDE_MS), e = ease(p);
    state.view.x = sx + (tx-sx)*e;
    state.view.y = sy + (ty-sy)*e;
    // Zoom is perceptually multiplicative: interpolate k geometrically.
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

export function worldAtOrCentre(sx?: number | null, sy?: number | null): { x: number; y: number } {
  return sx != null && sy != null ? screenToWorld(sx, sy) : screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
}

// (mx,my) relative to the stage.
export function zoomAt(mx: number, my: number, factor: number): void {
  cancelViewAnim();
  const k0 = state.view.k;
  const k1 = clamp(k0 * factor, MIN_ZOOM, MAX_ZOOM);
  state.view.x = mx - (mx - state.view.x) * (k1 / k0);
  state.view.y = my - (my - state.view.y) * (k1 / k0);
  state.view.k = k1;
  applyView();
}

// The stage is fixed inset:0, so the window size stands in before it has laid out.
export function stageSize(): { width: number; height: number } {
  const r = stage.getBoundingClientRect();
  return { width: r.width || window.innerWidth, height: r.height || window.innerHeight };
}

// A lone card too tall to read whole is framed by its width, top first. Null when it fits readably.
function frameTop(box: { x: number; y: number; w: number; h: number }, availW: number, availH: number,
                  pad: number, maxK: number): { x: number; y: number; k: number } | null {
  const kW = (availW - 2 * pad) / box.w, kH = (availH - 2 * pad) / box.h;
  if (kH >= FAR_ZOOM || kH >= kW) {
    return null;
  }
  const k = clamp(kW, FAR_ZOOM, maxK);
  return { x: availW / 2 - (box.x + box.w / 2) * k, y: pad - box.y * k, k };
}

const FIT_PAD = 60, FIT_MAX_K = 1.4;

export function fit(): void {
  const ns = [...state.nodes.values()].filter(n => !isHidden(n));
  if (!ns.length) {
    return;
  }
  const one = ns.length === 1 ? ns[0] : null;
  const top = one && frameTop({ x: one.x, y: one.y, w: nodeW(one), h: nodeH(one) }, stageSize().width, stageSize().height, FIT_PAD, FIT_MAX_K);
  if (top) {
    state.view.x = top.x; state.view.y = top.y; state.view.k = top.k;
    applyView();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of ns) {
    minX = Math.min(minX, n.x);          minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + nodeW(n)); maxY = Math.max(maxY, n.y + nodeH(n));
  }
  const r = stageSize();
  const k = Math.min(FIT_MAX_K, Math.min(r.width/(maxX-minX+2*FIT_PAD), r.height/(maxY-minY+2*FIT_PAD)));
  state.view.k = k;
  state.view.x = (r.width - (maxX-minX)*k)/2 - minX*k;
  state.view.y = (r.height - (maxY-minY)*k)/2 - minY*k;
  applyView();
}

// The height the float bar takes when docked along the bottom on a narrow screen.
export function bottomInset(): number {
  const fb = byId('floatBar');
  return (fb.classList.contains('open') && NARROW_MQ.matches) ? fb.offsetHeight : 0;
}

const FOCUS_MIN_K = 0.2, FOCUS_MAX_K = 1.0, FOCUS_PAD = 80;
export function frameBox(nodes: ReadonlyArray<MindNode | undefined>, instant = false): void {
  const group = nodes.filter((n): n is MindNode => !!n && !isHidden(n));
  if (!group.length) {
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of group){
    minX = Math.min(minX, n.x);            minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + nodeW(n));   maxY = Math.max(maxY, n.y + nodeH(n));
  }
  const bw = maxX - minX, bh = maxY - minY, cx = (minX+maxX)/2, cy = (minY+maxY)/2;
  const r = stageSize();
  const availW = r.width;
  const availH = r.height - bottomInset();
  const top = group.length === 1 ? frameTop({ x: minX, y: minY, w: bw, h: bh }, availW, availH, FOCUS_PAD, FOCUS_MAX_K) : null;
  if (top) {
    (instant ? jumpViewTo : animateViewTo)(top.x, top.y, top.k);
    return;
  }
  const k = clamp(Math.min((availW - 2*FOCUS_PAD) / bw, (availH - 2*FOCUS_PAD) / bh),
                  FOCUS_MIN_K, FOCUS_MAX_K);
  (instant ? jumpViewTo : animateViewTo)(availW/2 - cx*k, availH/2 - cy*k, k);
}

