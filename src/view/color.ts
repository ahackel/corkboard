// The palette, and what a colour value (palette key or authored hex) paints as.
import { inkFor, scrimFor, isHexColor } from '../utils/ink.js';

// Every key a note may carry; the hexes live only in styles.css's --pal-* properties. `slate` still
// paints but is no longer offered.
const PALETTE = ['slate','red','amber','green','teal','blue','violet','pink','grey','white','black',
  'orange','silver','stone','bold-red','bold-orange','bold-yellow','bold-green','bold-teal','bold-blue','bold-violet','bold-pink'];
// The second row is ten: the custom chip ends it.
export const PICKER_ROWS: string[][] = [
  ['black','stone','bold-red','bold-orange','bold-yellow','bold-green','bold-teal','bold-blue','bold-violet','bold-pink','white'],
  ['silver','grey','red','orange','amber','green','teal','blue','violet','pink'],
];
const pal = (name: string): string => getComputedStyle(document.body).getPropertyValue(`--pal-${name}`).trim();
// No prototype: a colour comes from a file, and `constructor` or `toString` must not read as a palette key.
export const SWATCH_BG: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>,
  Object.fromEntries(PALETTE.map(c => [c, pal(c)])));
// Cached: read on every edge paint.
const themeBg = (): string => getComputedStyle(document.body).getPropertyValue('--bg').trim();
export const THEME_BG = themeBg();
// Ink is derived from each fill (only JS can measure a colour), and each `.c-<key>` class is generated
// here too: adding a key to PALETTE and its --pal-* hex is the whole job. One <style>, off the paint path.
const inkStyle = document.createElement('style');
function deriveInk(): void {
  inkStyle.textContent = ':root{' + PALETTE.map(c => {
    const bg = SWATCH_BG[c] ?? '';
    return `--pal-ink-${c}:${inkFor(bg)};--pal-scrim-${c}:${scrimFor(bg)};`;
  }).join('') + '}' + PALETTE.map(c =>
    `.c-${c}{--card:var(--pal-${c});--ink:var(--pal-ink-${c});--scrim:var(--pal-scrim-${c})}`).join('');
}

export function installInk(): void {
  document.head.appendChild(inkStyle);
  deriveInk();
}
// Every consumer goes through these three, so a custom hex never needs a branch of its own. A custom
// colour gets .c-custom plus the same --card/--ink/--scrim triple inline (applyColorVars).
// Null for '', 'none' or unknown.
export function colorFill(c: string): string | null { return SWATCH_BG[c] ?? (isHexColor(c) ? c : null); }
export function colorClass(c: string): string { return isHexColor(c) ? 'c-custom' : 'c-' + c; }
// Removed for a palette key: an inline custom property would beat its .c-* class.
export function applyColorVars(el: HTMLElement, c: string): void {
  if (isHexColor(c)) {
    el.style.setProperty('--card', c);
    el.style.setProperty('--ink', inkFor(c));
    el.style.setProperty('--scrim', scrimFor(c));
  } else {
    for (const prop of ['--card', '--ink', '--scrim']) {
      el.style.removeProperty(prop);
    }
  }
}
