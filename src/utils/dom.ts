export interface PointerHandlers {
  move?: (e: PointerEvent) => void;
  up?: (e: PointerEvent) => void;
  cancel?: (e: PointerEvent) => void;
  key?: (e: KeyboardEvent) => void;
}

// Follow a gesture on `window` (so a lost pointer capture can't strand it) until the returned stop().
export function trackPointer(on: PointerHandlers): () => void {
  const listeners: Array<[string, EventListener]> = [];
  const add = (type: string, fn: ((e: never) => void) | undefined): void => {
    if (fn) {
      listeners.push([type, fn as EventListener]);
      window.addEventListener(type, fn as EventListener);
    }
  };
  add('pointermove', on.move);
  add('pointerup', on.up);
  add('pointercancel', on.cancel);
  add('keydown', on.key);
  return () => {
    for (const [type, fn] of listeners) {
      window.removeEventListener(type, fn);
    }
  };
}

// One element at a time wearing `cls`, like a drop hint: mark(el) moves the class there, mark(null) clears it.
export function classMarker(cls: string): (el: Element | null) => void {
  let marked: Element | null = null;
  return el => {
    if (el === marked) {
      return;
    }
    marked?.classList.remove(cls);
    marked = el;
    marked?.classList.add(cls);
  };
}

// The DOM shell (index.html) is FIXED — every id the app looks up is written there, so the lookup
// can't miss and the cast is safe. That's the whole helper: it replaces the
// `document.getElementById('x') as HTMLInputElement` pairs spelled out at ~40 sites, the
// `as unknown as SVGSVGElement` double-casts the SVG layers needed (hence the `Element` constraint
// rather than `HTMLElement`), and the three private copies of this same function that had drifted
// into existence beside them (main.ts, features/float-bar.ts, and the since-retired sketch layer).
// Anything genuinely OPTIONAL in the shell keeps its own nullable lookup — see features/canvas-color.ts,
// and view/grid.ts, which test for the element before wiring it up.
export function byId<T extends Element = HTMLElement>(id: string): T { return document.getElementById(id) as unknown as T; }

// The safe-area insets as NUMBERS, for the panels that are placed by SCRIPT rather than by CSS.
// index.html asks for `viewport-fit=cover`, so window.innerWidth/Height now include the strip under
// an iPhone's notch (BOTH sides in landscape) and under the home indicator — clamping a menu to the
// raw window edge parks it under the hardware. styles.css names the four values as --sa-t/r/b/l, but
// getComputedStyle hands a custom property holding an `env()` back UNRESOLVED, so this measures
// `.safe-probe` instead: a hidden zero-size element whose PADDING is those variables, and computed
// padding is always resolved px. Cached, because the float bar re-places itself every frame while
// it's open; only a rotation or a resize can change an inset, and both drop the cache.
export interface Insets { top: number; right: number; bottom: number; left: number }
let insets: Insets | null = null;
let probe: HTMLElement | null = null;
export function safeInsets(): Insets {
  if (insets) {
    return insets;
  }
  if (!probe){ probe = document.createElement('div'); probe.className = 'safe-probe'; document.body.appendChild(probe); }
  const cs = getComputedStyle(probe);
  insets = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0,
             bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
  return insets;
}
window.addEventListener('resize', () => { insets = null; });
window.addEventListener('orientationchange', () => { insets = null; });

// Park a floating panel at (left, top) in VIEWPORT coords, slid back inside the window if it would
// hang off an edge — the last step EVERY floating thing in the app takes, and it was written out
// twice per caller in five of them (the float bar and its popovers, the emoji picker, the canvas
// colour popover, the context menu). Returns where it really landed, which the float bar needs in
// order to draw its connector stem to the same point.
// Deliberately NOT utils/num.ts's `clamp`: the far edge is applied LAST here, so a panel too big for
// the window keeps its near edge on screen and overflows the far one (the case #ctxMenu's own
// max-height + overflow-y:auto is the fallback for). `clamp` would pin the opposite edge instead.
export function placeInViewport(el: HTMLElement, left: number, top: number, margin = 4): { left: number; top: number } {
  const sa = safeInsets();   // the margin is measured from the SAFE edge, not the screen's
  const l = Math.min(Math.max(left, margin + sa.left), window.innerWidth - sa.right - el.offsetWidth - margin);
  const t = Math.min(Math.max(top, margin + sa.top), window.innerHeight - sa.bottom - el.offsetHeight - margin);
  el.style.left = `${l}px`;
  el.style.top = `${t}px`;
  return { left: l, top: t };
}

// A popover is a free-floating island POP_GAP off its toolbar (`bar`, else its own button), centred on
// the button that opened it: above, or below when there's no room — or when `below` says so (the line
// toolbar's pickers open on the side away from the line). Every popover in the app is placed by this.
const POP_GAP = 8;
export function placePopover(pop: HTMLElement, anchor: HTMLElement, bar: HTMLElement = anchor, below = false): void {
  const ar = anchor.getBoundingClientRect(), br = bar.getBoundingClientRect();
  let top = below ? br.bottom + POP_GAP : br.top - pop.offsetHeight - POP_GAP;
  if (top < 4) {
    top = br.bottom + POP_GAP;
  }
  placeInViewport(pop, ar.left + ar.width / 2 - pop.offsetWidth / 2, top);
}

// …and every one closes the same way: a press anywhere outside it and its button, or Esc.
export function closeOnOutside(pop: HTMLElement, trigger: HTMLElement, close: () => void): void {
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (pop.classList.contains('open') && !pop.contains(t) && !trigger.contains(t)) {
      close();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop.classList.contains('open')) {
      close();
    }
  }, true);
}
