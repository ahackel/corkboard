// Gestures on the empty canvas: marquee select, pinch-zoom, hand-pan, wheel and Safari gesture zoom.
import { state, stage } from '../core/state.js';
import { isHidden } from '../utils/model.js';
import { applyView, cancelViewAnim, screenToWorld, zoomAt } from '../view/camera.js';
import { ui, gPointers, inPlaceEditActive, type Pt, type GestureEvt } from '../core/ui-state.js';
import { scopeActive } from '../nav/scope.js';
import { createNode, centredAt } from './crud.js';
import { endInPlaceEdit } from './inline-edit.js';
import { clamp } from '../utils/num.js';
import { nodeW, nodeH } from '../view/geometry.js';
import { exitScope } from '../nav/sections.js';
import { selectNode, setSelectionSet } from './selection.js';

const marqueeEl = Object.assign(document.createElement('div'), { id: 'marquee' });

const MOVE_THRESHOLD_PX = 3;
const PINCH_WHEEL_RATE = 0.01;
const WHEEL_ZOOM_IN = 1.15;
const WHEEL_ZOOM_OUT = 0.87;
const SAFARI_MIN_K = 0.2;
const SAFARI_MAX_K = 2.5;
const ORIENTATION_SETTLE_MS = 50;

const gDist = (a: Pt, b: Pt) => Math.hypot(a.x-b.x, a.y-b.y);

function startPinch(): void {
  const [a,b] = [...gPointers.values()];
  ui.pinch = { dist: gDist(a,b), cx:(a.x+b.x)/2, cy:(a.y+b.y)/2 };
}

function endGesturePointer(e: PointerEvent): boolean {
  if (!gPointers.has(e.pointerId)) {
    return false;
  }
  gPointers.delete(e.pointerId);
  if (gPointers.size < 2) {
    ui.pinch = null;
  }
  if (gPointers.size === 0){
    ui.pan = null; stage.classList.remove('panning');
    if (ui.marquee){ endMarquee(); }
  }
  return true;
}

// A no-move, non-additive band is a click: it deselects, or selects the section it started on.
function endMarquee(): void {
  const m = ui.marquee;
  if (!m) {
    return;
  }
  marqueeEl.style.display = 'none';
  if (!m.moved && !m.add) {
    selectNode(m.clickNode ?? null);
  }
  ui.marquee = null;
}

// A marquee from a press on an UNSELECTED section; a touch pointer joins gPointers so a second finger can pinch.
export function beginMarqueeFromNode(e: PointerEvent, nodeId: string): void {
  cancelViewAnim();
  endInPlaceEdit();
  if (e.pointerType !== 'mouse') {
    gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  }
  ui.marquee = { sx:e.clientX, sy:e.clientY, add:e.metaKey||e.ctrlKey||e.shiftKey, base:new Set(state.sel), moved:false, clickNode:nodeId };
  drawMarquee(e.clientX, e.clientY);
  marqueeEl.style.display = 'block';
}

function drawMarquee(cx: number, cy: number): void {
  const marquee = ui.marquee;
  if (!marquee) {
    return;
  }
  const r = stage.getBoundingClientRect();
  marqueeEl.style.left   = (Math.min(marquee.sx, cx) - r.left) + 'px';
  marqueeEl.style.top    = (Math.min(marquee.sy, cy) - r.top)  + 'px';
  marqueeEl.style.width  = Math.abs(cx - marquee.sx) + 'px';
  marqueeEl.style.height = Math.abs(cy - marquee.sy) + 'px';
}

function selectWithinMarquee(cx: number, cy: number): void {
  const marquee = ui.marquee;
  if (!marquee) {
    return;
  }
  const a = screenToWorld(Math.min(marquee.sx, cx), Math.min(marquee.sy, cy));
  const b = screenToWorld(Math.max(marquee.sx, cx), Math.max(marquee.sy, cy));
  // Measured ONCE per band: nothing moves under it, and re-measuring was most of its cost.
  if (!marquee.boxes) {
    marquee.boxes = [];
    for (const n of state.nodes.values()){
      // A band started inside a section would always enclose it; only its contents count.
      if (!isHidden(n) && n.id !== marquee.clickNode) {
        marquee.boxes.push({ id: n.id, x0: n.x, y0: n.y, x1: n.x + nodeW(n), y1: n.y + nodeH(n) });
      }
    }
  }
  const hits: string[] = [];
  for (const m of marquee.boxes) {
    if (m.x0 < b.x && m.x1 > a.x && m.y0 < b.y && m.y1 > a.y) {
      hits.push(m.id);
    }
  }
  const key = hits.join(' ');
  if (key === marquee.hits) {
    return;
  }
  marquee.hits = key;
  setSelectionSet(marquee.add ? new Set([...marquee.base, ...hits]) : hits);
}

// iOS Safari's landscape toolbar scrolls the document, and WebKit then draws the fixed #stage shifted
// while pointer coordinates are not. The app never scrolls the document, so undo any scroll.
function resetPageScroll(): void {
  if (window.scrollX || window.scrollY) {
    window.scrollTo(0, 0);
  }
}

export function installGestures(): void {
  stage.appendChild(marqueeEl);

  stage.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.node')) {
      return;
    }
    if (e.button === 2) {
      return;
    }
    cancelViewAnim();

    // Leaving an editor also lets go of the card, as FigJam does: left selected, the next click would edit.
    if (inPlaceEditActive()) {
      endInPlaceEdit();
      selectNode(null);
      return;
    }

    if (e.pointerType !== 'mouse'){
      gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
      if (gPointers.size === 1){
        ui.marquee = { sx:e.clientX, sy:e.clientY, add:false, base:new Set(state.sel), moved:false };
        drawMarquee(e.clientX, e.clientY);
        marqueeEl.style.display = 'block';
        stage.setPointerCapture(e.pointerId);
      } else if (gPointers.size === 2){
        ui.marquee = null; marqueeEl.style.display = 'none';
        startPinch();
      }
      return;
    }

    if (ui.spaceHeld || e.button === 1){
      if (ui.spaceHeld) {
        ui.spaceUsedForPan = true;
      }
      ui.pan = { sx:e.clientX, sy:e.clientY, ox:state.view.x, oy:state.view.y };
      stage.classList.add('panning');
      return;
    }

    ui.marquee = { sx:e.clientX, sy:e.clientY, add:e.metaKey||e.ctrlKey||e.shiftKey, base:new Set(state.sel), moved:false };
    drawMarquee(e.clientX, e.clientY);
    marqueeEl.style.display = 'block';
  });

  // Inside an open section a double-click LEAVES it (the inverse of going in); at the top it makes a card.
  stage.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.node')) {
      return;
    }
    if (scopeActive()) { exitScope(); return; }
    createNode(centredAt(screenToWorld(e.clientX, e.clientY)));
  });
  window.addEventListener('pointermove', (e) => {
    if (gPointers.has(e.pointerId)){
      gPointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
      const pinch = ui.pinch;
      if (pinch && gPointers.size >= 2){
        const [a,b] = [...gPointers.values()];
        const nd = gDist(a,b), ncx = (a.x+b.x)/2, ncy = (a.y+b.y)/2;

        // #stage is fixed at inset 0, so client coordinates are stage coordinates.
        if (pinch.dist > 0) {
          zoomAt(ncx, ncy, nd / pinch.dist);
        }
        state.view.x += ncx - pinch.cx;
        state.view.y += ncy - pinch.cy;
        applyView();
        pinch.dist = nd; pinch.cx = ncx; pinch.cy = ncy;
        return;
      }
    }
    if (ui.pan){
      state.view.x = ui.pan.ox + (e.clientX - ui.pan.sx);
      state.view.y = ui.pan.oy + (e.clientY - ui.pan.sy);
      applyView(); return;
    }
    const marquee = ui.marquee;
    if (marquee){
      if (Math.abs(e.clientX-marquee.sx) + Math.abs(e.clientY-marquee.sy) > MOVE_THRESHOLD_PX) {
        marquee.moved = true;
      }
      drawMarquee(e.clientX, e.clientY);
      if (marquee.moved) {
        selectWithinMarquee(e.clientX, e.clientY);
      }
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (endGesturePointer(e)) {
      return;
    }
    if (ui.pan){ ui.pan = null; stage.classList.remove('panning'); return; }
    if (ui.marquee) {
      endMarquee();
    }
  });
  window.addEventListener('pointercancel', (e) => {
    endGesturePointer(e);
  });

  // A macOS trackpad pinch arrives as a ctrlKey wheel, a two-finger pan as a plain one.
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelViewAnim();
    const r = stage.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (e.ctrlKey){
      zoomAt(mx, my, Math.exp(-e.deltaY * PINCH_WHEEL_RATE));
      return;
    }

    // Line mode or a 100/120px notch; trackpad scroll is fractional pixel mode.
    const isMouseWheel = e.deltaX === 0 &&
      (e.deltaMode === 1 || Math.abs(e.deltaY) === 100 || Math.abs(e.deltaY) === 120);
    if (isMouseWheel){
      zoomAt(mx, my, e.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT);
      return;
    }

    state.view.x -= e.deltaX;
    state.view.y -= e.deltaY;
    applyView();
  }, { passive:false });

  // Safari pinches with gesture events instead; a touchscreen pinch (gPointers) is already handled.
  stage.addEventListener('gesturestart', (ev) => {
    const e = ev as GestureEvt;
    if (gPointers.size) {
      return;
    }
    ui.gestureStartK = state.view.k;
    const r = stage.getBoundingClientRect();
    ui.gestureMid = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  stage.addEventListener('gesturechange', (ev) => {
    const e = ev as GestureEvt;
    if (gPointers.size) {
      return;
    }
    const k0 = state.view.k;
    const target = clamp(ui.gestureStartK * e.scale, SAFARI_MIN_K, SAFARI_MAX_K);
    zoomAt(ui.gestureMid.x, ui.gestureMid.y, target / k0);
  });

  // Block the BROWSER's page zoom everywhere: ctrl+wheel, and Safari's gesture events.
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
    }
  }, { passive:false });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'] as const) {
    window.addEventListener(type, (e) => e.preventDefault());
  }
  window.addEventListener('scroll', resetPageScroll, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(resetPageScroll, ORIENTATION_SETTLE_MS));
  resetPageScroll();
}
