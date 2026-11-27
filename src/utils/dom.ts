export interface PointerHandlers {
  move?: (e: PointerEvent) => void;
  up?: (e: PointerEvent) => void;
  cancel?: (e: PointerEvent) => void;
  key?: (e: KeyboardEvent) => void;
}

// Listens on `window`, so a lost pointer capture can't strand the gesture.
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

// Eats the click the browser may send after a drag's pointerup; with none, the wait ends with the task.
export function swallowNextClick(): void {
  const eat = (e: Event): void => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', eat, true), 0);
}

// mark(el) moves `cls` to el; mark(null) clears it.
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

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

// The ONE on-screen spelling of a shortcut, written the Mac way (⌘ ⌥ ⇧ ⌃ ⌫).
const PC_KEYS: Record<string, string> = { '⌘': 'Ctrl+', '⌃': 'Ctrl+', '⌥': 'Alt+', '⇧': 'Shift+', '⌫': 'Backspace' };

export function keys(s: string): string {
  return IS_MAC ? s : s.replace(/[⌘⌃⌥⇧⌫]/g, k => PC_KEYS[k]).replace(/Ctrl\+Ctrl\+/g, 'Ctrl+');
}

// The shell (index.html) is fixed, so these lookups can't miss; optional elements look themselves up.
export function byId<T extends Element = HTMLElement>(id: string): T { return document.getElementById(id) as unknown as T; }

// For panels placed by script under `viewport-fit=cover`. getComputedStyle returns a custom property
// holding `env()` UNRESOLVED, so a hidden probe's padding (resolved px) is measured instead.
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

export function installSafeInsets(): void {
  window.addEventListener('resize', () => { insets = null; });
  window.addEventListener('orientationchange', () => { insets = null; });
}

// Slides a floating panel back inside the window. Not `clamp`: the far edge goes LAST, so a panel too
// big for the window keeps its near edge on screen.
export function placeInViewport(el: HTMLElement, left: number, top: number, margin = 4): { left: number; top: number } {
  const sa = safeInsets();
  const l = Math.min(Math.max(left, margin + sa.left), window.innerWidth - sa.right - el.offsetWidth - margin);
  const t = Math.min(Math.max(top, margin + sa.top), window.innerHeight - sa.bottom - el.offsetHeight - margin);
  el.style.left = `${l}px`;
  el.style.top = `${t}px`;
  return { left: l, top: t };
}

// Centred on its button, POP_GAP off its toolbar: above, or below when there's no room (or `below`).
const POP_GAP = 8;

export function placePopover(pop: HTMLElement, anchor: HTMLElement, bar: HTMLElement = anchor, below = false): void {
  const ar = anchor.getBoundingClientRect(), br = bar.getBoundingClientRect();
  let top = below ? br.bottom + POP_GAP : br.top - pop.offsetHeight - POP_GAP;
  if (top < 4) {
    top = br.bottom + POP_GAP;
  }
  placeInViewport(pop, ar.left + ar.width / 2 - pop.offsetWidth / 2, top);
}

// A press outside it and its button closes it, as does Esc.
export function closeOnOutside(pop: HTMLElement, trigger: HTMLElement, close: () => void): void {
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (pop.classList.contains('open') && !pop.contains(t) && !trigger.contains(t)) {
      close();
    }
  }, true);

  // Esc closes the popover and nothing else (the press stops here).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop.classList.contains('open')) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }, true);
}
