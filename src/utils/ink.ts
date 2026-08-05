// Ink: the text colour a card's own fill demands, computed from that fill.
// Pure — a colour in, a colour out — so nothing here knows which colours the app offers; the
// palette wiring in main.ts (deriveInk) is the only place that enumerates them, which is what
// makes an off-palette colour work the same as a palette one.
//
// Two fixed inks, deliberately NOT theme-dependent: what a title has to be legible against is the
// CARD it sits on, and a card keeps its colour in both themes. The dark one is the #2b3645 the
// white card already used rather than pure black — on a light fill it reads as ink, not as a hole.
export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#2b3645';
// ONE threshold, for every colour and both themes (the --pal-* set is shared now, so a colour has
// exactly one ink wherever the map is opened): light ink is the map's default look, so it's kept
// unless its contrast drops below this — NOT simply whichever ink contrasts more. Max-contrast would
// flip four of the palette's own colours (amber 2.85 against white, green 3.09, teal 3.16, blue
// 3.95-vs-4.05), and a dark-text card among white-text ones reads as a bug rather than as a rule;
// the palette is meant to look like one set.
// 2.5 is derived from ONE requirement — every palette colour keeps white ink, the lowest being amber
// at 2.85 — with margin to spare, so dark ink is reserved for fills genuinely too pale for white.
// That's the case this exists for: an arbitrary colour picked outside the palette.
// Note it sits below the WCAG AA bar by design: it's a "preserve the authored look" threshold, not an
// accessibility one — the palette's own contrast is a choice made in styles.css, and ink only has to
// make the best of whatever fill it's handed. Below the threshold dark ink is always the better of
// the two by construction, so there's nothing to compare it against.
const INK_MIN = 2.5;
// A scrim is what an in-place editor paints BEHIND the ink (the title/body/query editors, the
// outline's fields): translucent, so the card's own colour still shows through, and on the far side
// of the ink, so the text it backs gains contrast instead of losing it. Pairing it with the ink is
// the whole point — a fixed dark scrim under dark ink is unreadable.
export const SCRIM_UNDER_LIGHT = 'rgba(0,0,0,.5)';
export const SCRIM_UNDER_DARK = 'rgba(255,255,255,.62)';

// Is this colour value an authored hex rather than a palette key? The one test that tells a custom
// colour from `'blue'`/`'none'`/`''` — used by the render core to decide between a `.c-<key>` class
// and per-node inline variables, and by the frontmatter writer to decide on quoting.
export function isHexColor(c: string): boolean { return c.startsWith('#') && parseHex(c) != null; }
// `#rgb` / `#rrggbb` → [r,g,b] 0-255. null for anything else (a named colour, `transparent`, a
// gradient) — callers treat that as "not a fill we can reason about" and keep the default ink.
function parseHex(c: string): [number, number, number] | null {
  const h = c.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return null;
}
// WCAG 2.1 relative luminance: gamma-expand each channel, then weight them by the eye's
// sensitivity. Not the same thing as "brightness" — green counts for 7× what blue does, which is
// exactly why a naive average picks the wrong ink on teal and violet.
function luminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const lin = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}
// WCAG contrast ratio, 1 (identical) … 21 (black on white). 1 for an unreadable colour, i.e. "no
// contrast established" — the pessimistic answer.
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  if (la == null || lb == null) return 1;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// The ink for a background fill. See INK_MIN above for why this isn't simply the higher contrast.
export function inkFor(bg: string): string {
  if (luminance(bg) == null) return INK_LIGHT;   // not a fill we can measure — keep the default look
  return contrastRatio(bg, INK_LIGHT) >= INK_MIN ? INK_LIGHT : INK_DARK;
}
// The scrim that pairs with that ink.
export function scrimFor(bg: string): string {
  return inkFor(bg) === INK_LIGHT ? SCRIM_UNDER_LIGHT : SCRIM_UNDER_DARK;
}
