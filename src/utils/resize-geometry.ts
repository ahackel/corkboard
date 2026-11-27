// The arithmetic of a resize: one box dragged by an edge or corner, and a multi-selection's frame scaled.
// The edges NOT dragged stay put; sizes clamp to a floor; a picture keeps its aspect. Pure, and pinned by
// tests/resize-geometry.test.ts.
import { snapTo } from './num.js';
import type { Side } from './guides.js';
import type { Edges } from './drag-geometry.js';
import type { Pt, Rect } from './rect.js';

export interface Sides { west: boolean; east: boolean; north: boolean; south: boolean }

// A handle's name (`n`, `se`, …) as the edges it moves.
export function sidesOf(dir: string): Sides {
  return { west: dir.includes('w'), east: dir.includes('e'), north: dir.includes('n'), south: dir.includes('s') };
}

// A smart guide's pull on each axis, or null where nothing lines up.
export interface Pull { x: number | null; y: number | null }

export interface ResizeOpts { minW: number; minH: number; aspect: number | null; round: (v: number) => number }

// A picture is driven by ONE axis, the other following its aspect: on a corner, whichever the pointer
// changes more (relative to the size it started at).
function aspectDrive(e0: Edges, s: Sides, d: Pt): { wRaw: number; hRaw: number; byWidth: boolean } {
  const w0 = e0.right - e0.left, h0 = e0.bottom - e0.top;
  const hasX = s.east || s.west, hasY = s.north || s.south;
  const wRaw = w0 + (s.east ? d.x : -d.x), hRaw = h0 + (s.south ? d.y : -d.y);
  const byWidth = hasX && (!hasY || Math.abs(wRaw - w0) * h0 >= Math.abs(hRaw - h0) * w0);
  return { wRaw, hRaw, byWidth };
}

// The box the raw pointer asks for, before the grid or a floor, and which of its edges move: what the
// smart guides are asked about. A picture offers only its driving edge.
export function resizeProbe(e0: Edges, s: Sides, d: Pt, aspect: number | null): { box: Rect; edges: { x?: Side; y?: Side } } {
  if (aspect) {
    const { wRaw, hRaw, byWidth } = aspectDrive(e0, s, d);
    const w = byWidth ? wRaw : hRaw * aspect, h = byWidth ? wRaw / aspect : hRaw;
    return {
      box: { x: s.west ? e0.right - w : e0.left, y: s.north ? e0.bottom - h : e0.top, w, h },
      edges: byWidth ? { x: s.west ? 'lo' : 'hi' } : { y: s.north ? 'lo' : 'hi' },
    };
  }
  const left = s.west ? e0.left + d.x : e0.left, top = s.north ? e0.top + d.y : e0.top;
  return {
    box: { x: left, y: top, w: (s.east ? e0.right + d.x : e0.right) - left, h: (s.south ? e0.bottom + d.y : e0.bottom) - top },
    edges: { x: s.west ? 'lo' : s.east ? 'hi' : undefined, y: s.north ? 'lo' : s.south ? 'hi' : undefined },
  };
}

// Where the edges end up: a guide's pull wins over the grid (`round`) on its axis, sizes stop at the floor,
// and the opposite edge holds still.
export function resizeEdges(e0: Edges, s: Sides, d: Pt, pull: Pull, o: ResizeOpts): Edges {
  const { left: left0, top: top0, right: right0, bottom: bottom0 } = e0;
  if (o.aspect) {
    const { wRaw, hRaw, byWidth } = aspectDrive(e0, s, d);
    let w: number, h: number;
    if (byWidth) {
      w = Math.max(o.minW, pull.x != null ? wRaw + (s.east ? pull.x : -pull.x) : o.round(wRaw));
      h = Math.max(o.minH, w / o.aspect);
    } else {
      h = Math.max(o.minH, pull.y != null ? hRaw + (s.south ? pull.y : -pull.y) : o.round(hRaw));
      w = Math.max(o.minW, h * o.aspect);
    }
    const left = s.west ? right0 - w : left0, top = s.north ? bottom0 - h : top0;
    return { left, top, right: left + w, bottom: top + h };
  }
  let left = left0, right = right0, top = top0, bottom = bottom0;
  const px = pull.x ?? 0, py = pull.y ?? 0;
  const keep = (v: number): number => v;
  const rx = pull.x != null ? keep : o.round, ry = pull.y != null ? keep : o.round;
  if (s.east) {
    right = left0 + Math.max(o.minW, rx(right0 + d.x + px - left0));
  }
  if (s.west) {
    left = right0 - Math.max(o.minW, rx(right0 - (left0 + d.x + px)));
  }
  if (s.south) {
    bottom = top0 + Math.max(o.minH, ry(bottom0 + d.y + py - top0));
  }
  if (s.north) {
    top = bottom0 - Math.max(o.minH, ry(bottom0 - (top0 + d.y + py)));
  }
  return { left, top, right, bottom };
}

// A picture scaled down until its SHORT side is icon-sized becomes the icon (it folds).
export function foldsToIcon(e: Edges, icon: number): boolean {
  return Math.min(e.right - e.left, e.bottom - e.top) <= icon;
}

// ---------- the selection frame ----------

// A member's own resize band, when that edge lies ON the frame, scales the whole group: the frame's handle
// it stands for, or '' when the member's edge is an inner one.
export function frameEdgeDir(member: Rect, frame: Rect, dir: string): string {
  const on = (a: number, b: number): boolean => Math.abs(a - b) < 1;
  const y = dir.includes('n') && on(member.y, frame.y) ? 'n' : dir.includes('s') && on(member.y + member.h, frame.y + frame.h) ? 's' : '';
  const x = dir.includes('w') && on(member.x, frame.x) ? 'w' : dir.includes('e') && on(member.x + member.w, frame.x + frame.w) ? 'e' : '';
  return y + x;
}

// How far the frame scales on each axis (1 on an axis not dragged), and the corner held still. The dragged
// side lands on the grid; the scale stops at `min` (its tightest member's floor); `uniform` (Shift on a
// corner) scales both axes alike.
export function frameScale(f0: Rect, s: Sides, d: Pt, grid: number, min: Pt, uniform: boolean): { sx: number; sy: number; anchor: Pt } {
  const l0 = f0.x, t0 = f0.y, r0 = f0.x + f0.w, b0 = f0.y + f0.h;
  const hasX = s.east || s.west, hasY = s.north || s.south;
  let sx = s.west ? (r0 - snapTo(l0 + d.x, grid)) / f0.w : s.east ? (snapTo(r0 + d.x, grid) - l0) / f0.w : 1;
  let sy = s.north ? (b0 - snapTo(t0 + d.y, grid)) / f0.h : s.south ? (snapTo(b0 + d.y, grid) - t0) / f0.h : 1;
  if (hasX) {
    sx = Math.max(sx, min.x);
  }
  if (hasY) {
    sy = Math.max(sy, min.y);
  }
  if (hasX && hasY && uniform) {
    sx = sy = Math.max(sx, sy);
  }
  return { sx, sy, anchor: { x: s.west ? r0 : l0, y: s.north ? b0 : t0 } };
}
