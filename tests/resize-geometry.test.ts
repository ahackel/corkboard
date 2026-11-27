import { describe, it, expect } from 'vitest';
import { sidesOf, resizeProbe, resizeEdges, foldsToIcon, frameEdgeDir, frameScale, type ResizeOpts } from '../src/utils/resize-geometry.js';
import { snapTo } from '../src/utils/num.js';

const e0 = { left: 100, top: 100, right: 300, bottom: 220 };   // 200 × 120
const none = { x: null, y: null };
const grid20 = (v: number): number => snapTo(v, 20);
const box: ResizeOpts = { minW: 200, minH: 120, aspect: null, round: grid20 };

describe('sidesOf', () => {
  it('reads the edges a handle moves', () => {
    expect(sidesOf('nw')).toEqual({ west: true, east: false, north: true, south: false });
    expect(sidesOf('s')).toEqual({ west: false, east: false, north: false, south: true });
  });
});

describe('resizeEdges: a box', () => {
  it('grows east with the size on the grid, the left edge holding still', () => {
    expect(resizeEdges(e0, sidesOf('e'), { x: 47, y: 0 }, none, box)).toEqual({ ...e0, right: 340 });
  });
  it('moves the west edge and keeps the east one', () => {
    expect(resizeEdges(e0, sidesOf('w'), { x: -61, y: 0 }, none, box)).toEqual({ ...e0, left: 40 });
  });
  it('stops at the minimum size, from either side', () => {
    expect(resizeEdges(e0, sidesOf('w'), { x: 150, y: 0 }, none, box)).toEqual(e0);
    expect(resizeEdges(e0, sidesOf('n'), { x: 0, y: 90 }, none, box)).toEqual(e0);
  });
  it('lets a guide’s pull win over the grid on its axis only', () => {
    const r = resizeEdges(e0, sidesOf('se'), { x: 47, y: 47 }, { x: 3, y: null }, box);
    expect(r).toEqual({ left: 100, top: 100, right: 350, bottom: 260 });
  });
});

describe('resizeEdges: a picture keeps its aspect', () => {
  const pic: ResizeOpts = { minW: 40, minH: 40, aspect: 2, round: grid20 };   // 200 × 100
  const p0 = { left: 0, top: 0, right: 200, bottom: 100 };
  it('drives the height from a dragged width', () => {
    expect(resizeEdges(p0, sidesOf('e'), { x: 100, y: 0 }, none, pic)).toEqual({ left: 0, top: 0, right: 300, bottom: 150 });
  });
  it('drives the width from a dragged height, anchored at the far corner', () => {
    expect(resizeEdges(p0, sidesOf('n'), { x: 0, y: -50 }, none, pic)).toEqual({ left: 0, top: -60, right: 320, bottom: 100 });
  });
  it('on a corner follows the axis the pointer changes more', () => {
    expect(resizeEdges(p0, sidesOf('se'), { x: 20, y: 60 }, none, pic)).toEqual({ left: 0, top: 0, right: 320, bottom: 160 });
  });
  it('folds to the icon once its short side is icon-sized', () => {
    const r = resizeEdges(p0, sidesOf('e'), { x: -130, y: 0 }, none, pic);
    expect(foldsToIcon(r, 40)).toBe(true);
    expect(foldsToIcon(p0, 40)).toBe(false);
  });
});

describe('resizeProbe', () => {
  it('asks the guides about the raw, unsnapped box and the edges that move', () => {
    expect(resizeProbe(e0, sidesOf('nw'), { x: -7, y: 5 }, null))
      .toEqual({ box: { x: 93, y: 105, w: 207, h: 115 }, edges: { x: 'lo', y: 'lo' } });
  });
  it('offers only a picture’s driving edge', () => {
    const p = resizeProbe({ left: 0, top: 0, right: 200, bottom: 100 }, sidesOf('se'), { x: 100, y: 10 }, 2);
    expect(p).toEqual({ box: { x: 0, y: 0, w: 300, h: 150 }, edges: { x: 'hi' } });
  });
});

describe('the selection frame', () => {
  const frame = { x: 0, y: 0, w: 400, h: 200 };
  it('hands a member’s edge to the frame only where the two coincide', () => {
    expect(frameEdgeDir({ x: 200, y: 0, w: 200, h: 100 }, frame, 'ne')).toBe('ne');
    expect(frameEdgeDir({ x: 200, y: 0, w: 200, h: 100 }, frame, 'se')).toBe('e');
    expect(frameEdgeDir({ x: 100, y: 50, w: 100, h: 50 }, frame, 'se')).toBe('');
  });
  it('scales by the dragged side, landing it on the grid, the opposite corner still', () => {
    expect(frameScale(frame, sidesOf('e'), { x: 195, y: 0 }, 20, { x: 0, y: 0 }, false))
      .toEqual({ sx: 1.5, sy: 1, anchor: { x: 0, y: 0 } });
    expect(frameScale(frame, sidesOf('nw'), { x: 200, y: 100 }, 20, { x: 0, y: 0 }, false))
      .toEqual({ sx: 0.5, sy: 0.5, anchor: { x: 400, y: 200 } });
  });
  it('stops shrinking at the tightest member’s floor', () => {
    expect(frameScale(frame, sidesOf('w'), { x: 380, y: 0 }, 20, { x: 0.5, y: 0.5 }, false).sx).toBe(0.5);
  });
  it('scales both axes alike when uniform', () => {
    const s = frameScale(frame, sidesOf('se'), { x: 400, y: 0 }, 20, { x: 0, y: 0 }, true);
    expect([s.sx, s.sy]).toEqual([2, 2]);
  });
});
