// The DOM shell (index.html) is FIXED — every id the app looks up is written there, so the lookup
// can't miss and the cast is safe. That's the whole helper: it replaces the
// `document.getElementById('x') as HTMLInputElement` pairs spelled out at ~40 sites, the
// `as unknown as SVGSVGElement` double-casts the SVG layers needed (hence the `Element` constraint
// rather than `HTMLElement`), and the three private copies of this same function that had drifted
// into existence beside them (main.ts, features/float-bar.ts, features/sketch.ts).
// Anything genuinely OPTIONAL in the shell keeps its own nullable lookup — see features/canvas-color.ts,
// view/grid.ts and view/theme.ts, which all test for the element before wiring it up.
export function byId<T extends Element = HTMLElement>(id: string): T { return document.getElementById(id) as unknown as T; }

// Park a floating panel at (left, top) in VIEWPORT coords, slid back inside the window if it would
// hang off an edge — the last step EVERY floating thing in the app takes, and it was written out
// twice per caller in five of them (the float bar and its popovers, the emoji picker, the canvas
// colour popover, the context menu). Returns where it really landed, which the float bar needs in
// order to draw its connector stem to the same point.
// Deliberately NOT utils/num.ts's `clamp`: the far edge is applied LAST here, so a panel too big for
// the window keeps its near edge on screen and overflows the far one (the case #ctxMenu's own
// max-height + overflow-y:auto is the fallback for). `clamp` would pin the opposite edge instead.
export function placeInViewport(el: HTMLElement, left: number, top: number, margin = 4): { left: number; top: number } {
  const l = Math.min(Math.max(left, margin), window.innerWidth - el.offsetWidth - margin);
  const t = Math.min(Math.max(top, margin), window.innerHeight - el.offsetHeight - margin);
  el.style.left = `${l}px`;
  el.style.top = `${t}px`;
  return { left: l, top: t };
}
