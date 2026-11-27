// Hovering (mouse) or tapping "N more lines" on a FOLDED card floats its note beside it, changing nothing.
// The panel is a `.node > .body` for the card text styles, outside #world so canvas walks never see it.
import { state, world } from '../core/state.js';
import { isBusy } from '../core/ui-state.js';
import { renderBodyHTML } from '../utils/markdown.js';
import { cardMarkdown } from '../utils/frontmatter.js';
import { placeInViewport } from '../utils/dom.js';
import { hydrateImages } from './images.js';

const PEEK_DELAY = 450;   // sweeping the pointer across the board never flashes one
const GAP = 10;

const panel = Object.assign(document.createElement('div'), { id: 'peek', className: 'node', innerHTML: '<div class="body"></div>' });
const panelBody = panel.querySelector('.body') as HTMLElement;

let showingId: string | null = null;
let timer: number | null = null;

function cancel(): void { if (timer != null) { clearTimeout(timer); timer = null; } }

function hidePeek(): void {
  cancel();
  showingId = null;
  panel.classList.remove('open');
}

// The tap on a folded card's "N more lines": toggles the panel.
export function peekCard(cardEl: HTMLElement): void {
  if (showingId === cardEl.dataset.id) { hidePeek(); return; }
  hidePeek();
  show(cardEl);
}

function show(cardEl: HTMLElement): void {
  const n = state.nodes.get(cardEl.dataset.id ?? '');
  if (!n || !n.collapsed || n.type === 'section' || isBusy() || !cardEl.isConnected) {
    return;
  }
  showingId = n.id;
  panel.className = 'node open ' + [...cardEl.classList].filter(c => c.startsWith('c-')).join(' ');
  for (const v of ['--card', '--ink', '--scrim']) {
    const val = cardEl.style.getPropertyValue(v);
    if (val) {
      panel.style.setProperty(v, val);
    } else {
      panel.style.removeProperty(v);
    }
  }
  panelBody.innerHTML = renderBodyHTML(cardMarkdown(n));
  hydrateImages(panelBody, n.file);
  panel.scrollTop = 0;
  const r = cardEl.getBoundingClientRect();
  const w = panel.offsetWidth;
  const fitsRight = r.right + GAP + w <= window.innerWidth;
  const x = fitsRight ? r.right + GAP : r.left - GAP - w;
  placeInViewport(panel, x, r.top);
}

export function installPeek(): void {
  document.body.appendChild(panel);
  world.addEventListener('pointerover', (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') {
      return;
    }
    const el = (e.target as Element).closest<HTMLElement>('.node.collapsed[data-id]');
    if (!el || el.dataset.id === showingId) {
      return;
    }
    hidePeek();
    timer = window.setTimeout(() => { timer = null; show(el); }, PEEK_DELAY);
  });
  world.addEventListener('pointerout', (e: PointerEvent) => {
    const to = e.relatedTarget as Node | null;
    const from = (e.target as Element).closest('.node[data-id]');
    if (to && (panel.contains(to) || (from && from.contains(to)))) {
      return;
    }
    hidePeek();
  });
  panel.addEventListener('pointerleave', (e: PointerEvent) => {
    const to = e.relatedTarget as Element | null;
    if (to?.closest?.(`.node[data-id="${showingId}"]`)) {
      return;
    }
    hidePeek();
  });

  // Not on "N more lines": peekCard toggles it itself.
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!panel.contains(t) && !t.closest?.('.fold-more')) {
      hidePeek();
    }
  }, true);
  document.addEventListener('keydown', () => hidePeek(), true);
  window.addEventListener('wheel', (e) => {
    if (!panel.contains(e.target as Node)) {
      hidePeek();
    }
  }, { passive: true, capture: true });
  window.addEventListener('blur', hidePeek);
}
