// ---------- colour: the palette, and what a colour VALUE paints as ----------
import { inkFor, scrimFor, isHexColor, paleFill } from '../utils/ink.js';

// colour palette (keys match the .c-* CSS classes); 'grey' is the old neutral "none" look.
// The hexes themselves live in ONE place — the --pal-* custom properties in styles.css's
// :root — so CSS (.c-*, #ghostCard) and JS (edges/backgrounds fills, swatch dots below) can never
// drift apart.
// Every key a note may carry. `slate` predates FigJam's palette: it still paints, but the picker no
// longer offers it.
const PALETTE = ['slate','red','amber','green','teal','blue','violet','pink','grey','white','black',
  'orange','silver','stone','bold-red','bold-orange','bold-yellow','bold-green','bold-teal','bold-blue','bold-violet','bold-pink',
  'light-grey','light-red','light-orange','light-yellow','light-green','light-teal','light-blue','light-violet','light-pink','cork'];
// …and what the picker OFFERS, FigJam's two rows of eleven: the strong hues framed by black and white,
// then the pastels — the sticky colours — framed by two greys (the custom chip ends that row).
export const PICKER_ROWS: string[][] = [
  ['black','stone','bold-red','bold-orange','bold-yellow','bold-green','bold-teal','bold-blue','bold-violet','bold-pink','white'],
  ['silver','grey','red','orange','amber','green','teal','blue','violet','pink'],
];
const pal = (name: string): string => getComputedStyle(document.body).getPropertyValue(`--pal-${name}`).trim();
export const SWATCH_BG: Record<string, string> = Object.fromEntries(PALETTE.map(c => [c, pal(c)]));
// The canvas's own THEME fill, read and cached exactly like the palette above. It's canvasSurface's last
// resort, when the map has no colour of its own. Cached rather than read live because it runs on every
// edge paint.
const themeBg = (): string => getComputedStyle(document.body).getPropertyValue('--bg').trim();
export const THEME_BG = themeBg();
// ---------- ink: the text colour each palette fill demands ----------
// Ink is COMPUTED from the fill (utils/ink.ts — WCAG contrast, biased toward the map's default
// light ink), never authored, which is the point: the old scheme spelled out per-colour text
// exceptions ("white is too bright for white text; in the light theme everything except grey and
// black flips to black") and had to repeat that list on every surface that wears a .c-* class —
// four copies to keep in step, and no answer at all for a colour outside the palette.
// The computed values reach CSS as --pal-ink-*/--pal-scrim-* custom properties on :root, injected
// here rather than written in styles.css because only JS can measure a colour; the .c-* rules there
// hand them to each card as --ink/--scrim, so ONE `color: var(--ink)` per surface now covers every
// colour in both themes. Injecting a <style> (not a per-node inline style) keeps this off the paint
// path entirely — it's 11 rules written twice per session, not per card per section.
const inkStyle = document.createElement('style');
document.head.appendChild(inkStyle);
// …and the `.c-<key>` class each key is worn by, generated here beside its ink rather than listed by
// hand in styles.css, so adding a key to PALETTE (and its --pal-* hex) is the whole job.
function deriveInk(): void {
  inkStyle.textContent = ':root{' + PALETTE.map(c => {
    const bg = SWATCH_BG[c] ?? '';
    return `--pal-ink-${c}:${inkFor(bg)};--pal-scrim-${c}:${scrimFor(bg)};`;
  }).join('') + '}' + PALETTE.map(c =>
    `.c-${c}{--card:var(--pal-${c});--ink:var(--pal-ink-${c});--scrim:var(--pal-scrim-${c})}`).join('');
}
deriveInk();
// ---------- a colour VALUE: a palette key, or an authored hex ----------
// `n.color` (and so effectiveColor's result) is one of: '' (inherit), 'none', a PALETTE KEY, or a
// custom '#rrggbb' picked from the colour popover. These three resolve any of them, and every
// consumer goes through them so "custom" never needs a branch of its own:
//   colorFill  — the hex it paints as, for the things JS tints itself (edges, the canvas).
//                null for 'none'/inherit/unknown, which callers already fall back to --edge for.
//   colorClass — the CSS class to hang on the element. A hex can't be a class name (and there'd be
//                nowhere to put its hexes), so a custom colour gets .c-custom + inline variables…
//   applyColorVars — …which are those variables: the same --card/--ink/--scrim triple a .c-* class
//                provides, just computed per node instead of once per palette key. Everything
//                downstream keys off the variables alone, so a custom colour behaves exactly like a
//                palette one — including the :not(.c-none) tests.
// One inline declaration per coloured node is affordable where a generated stylesheet isn't: the set
// of custom colours in a map is open-ended, and a node's own style attribute is already written on
// every paint.
export function colorFill(c: string): string | null { return SWATCH_BG[c] ?? (isHexColor(c) ? c : null); }
export function colorClass(c: string): string { return isHexColor(c) ? 'c-custom' : 'c-' + c; }

// ---------- SURFACE colours: the board's and the sections' own palette ----------
// FigJam's way: a SURFACE (the board, a section) has its own palette of light tints, painted EXACTLY as
// picked — so the same chip on the board and on a section is the same colour — while cards keep the
// sticky palette above. Each tint is the pale twin of a sticky colour (SURFACE_TONE), and a card nobody
// coloured, sitting in a tinted section, wears that sticky (main.ts effectiveColor) — the tint says
// what the cards in it are. `cork` is a surface too, a MATERIAL: it paints as a TEXTURE over its --pal-*
// base and has no sticky twin, so a card pinned to cork stays the default yellow.
export const SURFACE_ROW = ['white','light-grey','light-red','light-orange','light-yellow','light-green',
  'light-teal','light-blue','light-violet','light-pink'];
const SURFACE_TONE: Record<string, string> = {
  'light-grey': 'grey', 'light-red': 'red', 'light-orange': 'orange', 'light-yellow': 'amber',
  'light-green': 'green', 'light-teal': 'teal', 'light-blue': 'blue', 'light-violet': 'violet', 'light-pink': 'pink',
};
const TEXTURES: Record<string, string> = { cork: 'var(--tex-cork)' };
export function colorTexture(c: string): string | null { return TEXTURES[c] ?? null; }

// What a card inheriting a surface colour wears: its sticky twin; none (null) for a material; any other
// colour — a sticky key, white, a custom hex — passes through as itself.
export function cardTone(c: string): string | null {
  return c in TEXTURES ? null : SURFACE_TONE[c] ?? c;
}

// …and the other way: the surface colour standing for a STICKY one, for a section that is handed one — a
// map from before the surface palette, a stack turned into a section (its pin's colour), a mixed selection
// coloured from the card palette. A sticky key becomes its light twin (a strong one too; the greys and
// black go light grey), a custom hex its pale wash (paleFill — what its box used to show), and a surface
// colour stays itself.
const STICKY_SURFACE: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SURFACE_TONE).map(([light, tone]) => [tone, light])),
  'bold-red': 'light-red', 'bold-orange': 'light-orange', 'bold-yellow': 'light-yellow', 'bold-green': 'light-green',
  'bold-teal': 'light-teal', 'bold-blue': 'light-blue', 'bold-violet': 'light-violet', 'bold-pink': 'light-pink',
  slate: 'light-blue', silver: 'light-grey', stone: 'light-grey', black: 'light-grey',
};
export function surfaceColorOf(c: string): string {
  if (isHexColor(c)) {
    return paleFill(c);
  }
  return STICKY_SURFACE[c] ?? c;
}

// What a swatch chip shows for a colour: the texture, if it has one, over its fill.
export function swatchBg(c: string): string {
  const fill = colorFill(c) ?? '';
  const tex = colorTexture(c);
  return tex ? `${tex} center / 120px 120px, ${fill}` : fill;
}

// SET for a custom colour, REMOVED otherwise. Removing matters —
// recolouring a custom card back to a palette key has to drop the inline triple, or it would keep
// overriding the .c-* class that now owns the colour (an inline custom property beats any selector).
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
