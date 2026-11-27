// The open-section path in #homeBar: the only thing on screen that says which section you're in.
// A deep path folds its middle into `…`; bounding the segment COUNT is what keeps it clear of the search bar.
import { state } from '../core/state.js';
import { nodeLabel } from '../utils/model.js';
import { store } from '../data/active-store.js';
import { scope, scopeActive } from '../nav/scope.js';
import { openMenu, type MenuEntry } from './context-menu.js';
import { esc } from '../utils/markdown.js';
import { byId } from '../utils/dom.js';
import { FOLDER_SVG, DOCUMENT_SVG } from '../view/icons.js';
import { applyColorVars, colorClass, THEME_BG } from '../view/color.js';
import { effectiveColor } from '../render.js';
import { goToScopeDepth } from '../nav/sections.js';

const homeBar = byId('homeBar');
const mapCrumb = byId('folderName');
const bar = byId('scopeBar');

// Section levels spelled out in full, deepest first.
const SHOWN_TAIL = 2;

// `depth` is goToScopeDepth's: scope.stack[i]'s crumb carries i + 1, which lands you IN that level.
function crumb(depth: number, label: string, current: boolean): string {
  return `<span class="sc-sep" aria-hidden="true">›</span>`
    + `<button type="button" class="sc-crumb sc-section${current ? ' sc-cur' : ''}" data-depth="${depth}"`
    + `${current ? ' aria-current="page"' : ''} title="${esc(label)}">`
    + `${pill(FOLDER_SVG, label)}</button>`;
}

const pill = (icon: string, label: string): string =>
  `<span class="sc-pill"><span class="fold-icon">${icon}</span><span class="sc-name">${esc(label)}</span></span>`;

// Also run by data/persistence.ts the moment a map opens, ahead of any paint.
export function paintMapCrumb(): void {
  if (!store.name) {
    mapCrumb.textContent = '';
    return;
  }
  const icon = state.singleNote ? DOCUMENT_SVG : FOLDER_SVG;
  mapCrumb.innerHTML = pill(icon, store.name);
  tint(mapCrumb, state.canvasColor || THEME_BG);
}

function tint(el: HTMLElement, col: string): void {
  el.className = el.className.replace(/\bc-\S+/g, '').trim() + ' ' + colorClass(col);
  applyColorVars(el, col);
}

function paintCrumbColors(): void {
  bar.querySelectorAll<HTMLElement>('.sc-section').forEach(el => tint(el, levelColor(Number(el.dataset.depth) - 1)));
}

const levelColor = (i: number): string => {
  const p = state.nodes.get(scope.stack[i]?.rootId ?? '');
  return p ? effectiveColor(p) : 'white';
};

const levelTitle = (i: number): string => {
  const p = state.nodes.get(scope.stack[i]!.rootId);
  return p ? nodeLabel(p) : '…';
};

// The levels `…` stands for, outermost first.
const foldedLevels = (): number[] =>
  scope.stack.length > SHOWN_TAIL ? [...Array(scope.stack.length - SHOWN_TAIL).keys()] : [];

// Run from paintAll, which runs every frame of a resize drag: hence the signature guard.
export function renderCrumbs(): void {
  const sig = store.name + '|' + state.singleNote + '|' + state.canvasColor + (!scopeActive() ? ''
    : '|' + scope.stack.map((l, i) => l.rootId + ':' + levelTitle(i) + ':' + levelColor(i)).join('/'));
  if (bar.dataset.sig === sig) {
    return;
  }
  bar.dataset.sig = sig;
  paintMapCrumb();
  document.body.classList.toggle('scoped', scopeActive());
  mapCrumb.classList.toggle('sc-cur', !scopeActive());
  mapCrumb.dataset.depth = '0';
  if (!scopeActive()) { bar.innerHTML = ''; return; }
  const folded = foldedLevels();
  const html = folded.length
    ? `<span class="sc-sep" aria-hidden="true">›</span>`
      + `<button type="button" class="sc-crumb sc-more" data-more="1"`
      + ` title="${esc(folded.map(i => levelTitle(i)).join(' › '))}">…</button>`
    : '';
  bar.innerHTML = html + scope.stack.slice(folded.length)
    .map((_, k) => {
      const i = folded.length + k;
      return crumb(i + 1, levelTitle(i), i === scope.stack.length - 1);
    }).join('');
  paintCrumbColors();
}

export function installBreadcrumbs(): void {
  // On the whole pill: the map segment (#folderName) is a sibling of #scopeBar.
  homeBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.sc-crumb');
    if (!btn) {
      return;
    }

    if (btn.dataset.more) {
      const r = btn.getBoundingClientRect();
      const entries: MenuEntry[] = foldedLevels().map(i => ({ label: levelTitle(i), run: () => goToScopeDepth(i + 1) }));
      if (entries.length) {
        openMenu(entries, r.left, r.bottom + 4);
      }
      return;
    }

    goToScopeDepth(Number(btn.dataset.depth));
  });
}
