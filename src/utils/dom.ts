// The DOM shell (index.html) is FIXED — every id the app looks up is written there, so the lookup
// can't miss and the cast is safe. That's the whole helper: it replaces the
// `document.getElementById('x') as HTMLInputElement` pairs spelled out at ~40 sites, the
// `as unknown as SVGSVGElement` double-casts the SVG layers needed (hence the `Element` constraint
// rather than `HTMLElement`), and the three private copies of this same function that had drifted
// into existence beside them (main.ts, features/float-bar.ts, features/sketch.ts).
// Anything genuinely OPTIONAL in the shell keeps its own nullable lookup — see features/canvas-color.ts,
// view/grid.ts and view/theme.ts, which all test for the element before wiring it up.
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
  if (insets) return insets;
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
