// ---------- peek: read a FOLDED card without unfolding it ----------
// Rest the mouse on a collapsed card for a moment and its whole note floats beside it, in the card's own
// colour. Reading changes nothing — no fold state, no layout, no save — which is the point: a fold is how
// you keep the board tidy, and checking what's under one shouldn't undo it. Hover is mouse-only; TAPPING
// the card's "N more lines" (peekCard) opens the same panel on any device, which is the touch way in.
//
// The panel is a `.node` with a `.body` so it picks up the card text styles (headings, lists, code) from
// the same rules a card uses; it lives outside #world, so nothing that walks the canvas ever sees it.
import { state, world } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { renderBodyHTML } from '../utils/markdown.js';
import { joinHeading } from '../utils/frontmatter.js';
import { placeInViewport } from '../utils/dom.js';
import { hydrateImages } from './images.js';

const PEEK_DELAY = 450;   // long enough that sweeping the pointer across the board never flashes one
const GAP = 10;

const panel = document.createElement('div');
panel.id = 'peek';
panel.className = 'node';
panel.innerHTML = '<div class="body"></div>';
document.body.appendChild(panel);
const panelBody = panel.querySelector('.body') as HTMLElement;

let showing: string | null = null;   // the card id the panel is for
let timer: number | null = null;

function cancel(): void { if (timer != null) { clearTimeout(timer); timer = null; } }
function hidePeek(): void {
  cancel();
  showing = null;
  panel.classList.remove('open');
}

function busy(): boolean {
  return !!ui.drag || !!ui.bodyEdit || !!ui.titleEdit || !!ui.edgeDraw || document.body.classList.contains('grabbing')
      || document.body.classList.contains('canvas-interacting');
}

// Tap/click on a folded card's "N more lines": the panel at once, or away again if it's already up.
export function peekCard(cardEl: HTMLElement): void {
  if (showing === cardEl.dataset.id) { hidePeek(); return; }
  hidePeek();
  show(cardEl);
}
function show(cardEl: HTMLElement): void {
  const n = state.nodes.get(cardEl.dataset.id ?? '');
  if (!n || !n.collapsed || n.type === 'frame' || busy() || !cardEl.isConnected) return;   // a folded frame's pill is a count, not a note
  showing = n.id;
  // the card's own colour: its palette class, or a custom colour's variables
  panel.className = 'node open ' + [...cardEl.classList].filter(c => c.startsWith('c-')).join(' ');
  for (const v of ['--card', '--ink', '--scrim']) {
    const val = cardEl.style.getPropertyValue(v);
    if (val) panel.style.setProperty(v, val); else panel.style.removeProperty(v);
  }
  panelBody.innerHTML = renderBodyHTML(joinHeading(n.title, n.body, n.titleGap !== false));
  hydrateImages(panelBody);
  panel.scrollTop = 0;
  // beside the card — to its right, or its left when the right has no room
  const r = cardEl.getBoundingClientRect();
  const w = panel.offsetWidth;
  const x = r.right + GAP + w <= window.innerWidth ? r.right + GAP : r.left - GAP - w;
  placeInViewport(panel, x, r.top);
}

export function installPeek(): void {
  world.addEventListener('pointerover', (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const el = (e.target as Element).closest<HTMLElement>('.node.collapsed[data-id]');
    if (!el || el.dataset.id === showing) return;
    hidePeek();
    timer = window.setTimeout(() => { timer = null; show(el); }, PEEK_DELAY);
  });
  world.addEventListener('pointerout', (e: PointerEvent) => {
    const to = e.relatedTarget as Node | null;
    const from = (e.target as Element).closest('.node[data-id]');
    if (to && (panel.contains(to) || (from && from.contains(to)))) return;   // still on the card, or onto the panel
    hidePeek();
  });
  panel.addEventListener('pointerleave', (e: PointerEvent) => {
    const to = e.relatedTarget as Element | null;
    if (to?.closest?.(`.node[data-id="${showing}"]`)) return;   // back onto its card
    hidePeek();
  });
  // anything that acts on the board puts it away
  // (not a press on "N more lines": that one toggles it itself, in peekCard)
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!panel.contains(t) && !t.closest?.('.fold-more')) hidePeek();
  }, true);
  document.addEventListener('keydown', () => hidePeek(), true);
  window.addEventListener('wheel', (e) => { if (!panel.contains(e.target as Node)) hidePeek(); }, { passive: true, capture: true });
  window.addEventListener('blur', hidePeek);
}
