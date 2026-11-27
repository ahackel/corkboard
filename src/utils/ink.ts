// The text colour a fill demands, computed from the fill alone (so off-palette colours work too).
// Not theme-dependent: a card keeps its colour in both themes.
export const INK_LIGHT = '#ffffff';
export const INK_DARK = '#1e1e1e';   // FigJam's text colour

// White ink is kept until contrast drops below this, NOT whichever contrasts more: max-contrast would
// flip four palette colours (amber is the lowest at 2.85). Deliberately below WCAG AA.
const INK_MIN = 2.5;

// Translucent backing for an in-place editor, on the far side of the ink so the text gains contrast.
export const SCRIM_UNDER_LIGHT = 'rgba(0,0,0,.5)';
export const SCRIM_UNDER_DARK = 'rgba(255,255,255,.62)';

// Tells a custom colour from a palette key (`'blue'`, `'none'`, `''`).
export function isHexColor(c: string): boolean { return c.startsWith('#') && parseHex(c) != null; }

// null for anything else (a named colour, a gradient): callers keep the default ink.
function parseHex(c: string): [number, number, number] | null {
  const h = c.trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(h)) {
    return null;
  }
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  if (h.length === 6) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return null;
}

// Must match `.node.section`'s color-mix in styles.css; JS needs it for an open section's canvas.
export const SECTION_WASH = 0.32;

export function paleFill(c: string): string {
  const rgb = parseHex(c);
  if (!rgb) {
    return c;
  }
  return '#' + rgb.map(v => Math.round(255 - (255 - v) * SECTION_WASH).toString(16).padStart(2, '0')).join('');
}

// WCAG 2.1 relative luminance.
function luminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) {
    return null;
  }
  const lin = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

// 1 for an unreadable colour: the pessimistic answer.
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  if (la == null || lb == null) {
    return 1;
  }
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// See INK_MIN for why this isn't simply the higher contrast.
export function inkFor(bg: string): string {
  if (luminance(bg) == null) {
    return INK_LIGHT;
  }
  return contrastRatio(bg, INK_LIGHT) >= INK_MIN ? INK_LIGHT : INK_DARK;
}

export function scrimFor(bg: string): string {
  return inkFor(bg) === INK_LIGHT ? SCRIM_UNDER_LIGHT : SCRIM_UNDER_DARK;
}

// Imported notes may carry `#FFF`; without folding, one colour would show as two chips.
export function normalizeColor(c: string): string {
  const h = c.trim().toLowerCase();
  if (!isHexColor(h)) {
    return '';
  }
  const d = h.slice(1);
  return d.length === 3 ? `#${d[0]}${d[0]}${d[1]}${d[1]}${d[2]}${d[2]}` : `#${d}`;
}
