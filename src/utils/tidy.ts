// Tidy up, align and distribute as pure geometry: boxes in, a top-left for every box out.

export interface Box { id: string; x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }
export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

// A box joins the row above when it overlaps it vertically AND shares no column with it, so a messy
// column stays a column and a drifting row stays a row.
export function rowsOf(items: Box[]): Box[][] {
  const rows: Array<{ top: number; bottom: number; items: Box[] }> = [];
  const sideBySide = (a: Box, b: Box): boolean => Math.min(a.x + a.w, b.x + b.w) <= Math.max(a.x, b.x);
  for (const it of [...items].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x)) {
    const row = rows[rows.length - 1];
    const overlap = row ? Math.min(row.bottom, it.y + it.h) - Math.max(row.top, it.y) : -1;
    if (row && overlap > 0 && row.items.every(o => sideBySide(o, it))) {
      row.items.push(it);
      row.top = Math.min(row.top, it.y); row.bottom = Math.max(row.bottom, it.y + it.h);
    } else {
      rows.push({ top: it.y, bottom: it.y + it.h, items: [it] });
    }
  }
  return rows.map(r => r.items.sort((a, b) => a.x - b.x));
}

// FigJam's TIDY UP: the rows become a GRID (columns as wide as their widest, rows as tall as their
// tallest), order kept, starting at the selection's top-left.
export function tidyGrid(items: Box[], gap: number, origin?: Pt): Map<string, Pt> {
  const out = new Map<string, Pt>();
  if (!items.length) {
    return out;
  }
  const rows = rowsOf(items);
  const cols = Math.max(...rows.map(r => r.length));
  const colW = Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map(r => r[c]?.w ?? 0)));
  const rowH = rows.map(r => Math.max(...r.map(b => b.h)));
  const x0 = origin?.x ?? Math.min(...items.map(b => b.x));
  const y0 = origin?.y ?? Math.min(...items.map(b => b.y));
  let y = y0;
  rows.forEach((r, ri) => {
    let x = x0;
    r.forEach((b, ci) => { out.set(b.id, { x, y }); x += colW[ci] + gap; });
    y += rowH[ri] + gap;
  });
  return out;
}

export function align(items: Box[], edge: AlignEdge): Map<string, Pt> {
  const x0 = Math.min(...items.map(b => b.x)), x1 = Math.max(...items.map(b => b.x + b.w));
  const y0 = Math.min(...items.map(b => b.y)), y1 = Math.max(...items.map(b => b.y + b.h));
  const out = new Map<string, Pt>();
  for (const b of items) {
    const x = edge === 'left' ? x0 : edge === 'right' ? x1 - b.w : edge === 'center' ? (x0 + x1) / 2 - b.w / 2 : b.x;
    const y = edge === 'top' ? y0 : edge === 'bottom' ? y1 - b.h : edge === 'middle' ? (y0 + y1) / 2 - b.h / 2 : b.y;
    out.set(b.id, { x, y });
  }
  return out;
}

// The first and last box stay put; the ones between slide so every gap is equal.
export function distribute(items: Box[], axis: 'x' | 'y'): Map<string, Pt> {
  const out = new Map<string, Pt>(items.map(b => [b.id, { x: b.x, y: b.y }]));
  if (items.length < 3) {
    return out;
  }
  const size = (b: Box): number => axis === 'x' ? b.w : b.h;
  const sorted = [...items].sort((a, b) => a[axis] - b[axis]);
  const first = sorted[0], last = sorted[sorted.length - 1];
  const span = last[axis] + size(last) - first[axis];
  const gap = (span - sorted.reduce((s, b) => s + size(b), 0)) / (sorted.length - 1);
  let at = first[axis];
  for (const b of sorted) {
    out.set(b.id, axis === 'x' ? { x: at, y: b.y } : { x: b.x, y: at });
    at += size(b) + gap;
  }
  return out;
}
