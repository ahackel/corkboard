import { describe, it, expect } from 'vitest';
import { gridCells, fanArc, fanInsertAt, reorderedPile } from '../src/utils/fan.js';

describe('gridCells', () => {
  it('lays ⌈√n⌉ columns as wide as the widest card, rows as tall as their tallest', () => {
    const g = gridCells([{ w: 100, h: 50 }, { w: 200, h: 80 }, { w: 100, h: 40 }], 10);
    expect(g.at).toEqual([{ x: 0, y: 0 }, { x: 210, y: 0 }, { x: 0, y: 90 }]);
    expect(g.w).toBe(410);
    expect(g.h).toBe(130);
  });
});

describe('fanArc', () => {
  const style = { gap: 16, lift: 20, dip: 18, tilt: 6 };
  it('holds one card straight, centred, lifted over the pile', () => {
    expect(fanArc([200], 500, 100, style)).toEqual([{ x: 400, y: 80, tilt: 0 }]);
  });
  it('spreads cards side by side, the ends lower and tilted out', () => {
    const [a, b, c] = fanArc([200, 200, 200], 500, 100, style);
    expect([a.x, b.x, c.x]).toEqual([184, 400, 616]);
    expect([a.y, b.y, c.y]).toEqual([98, 80, 98]);
    expect([a.tilt, b.tilt, c.tilt]).toEqual([-6, 0, 6]);
  });
});

describe('fanInsertAt', () => {
  // the fan as laid out, top card first
  const shown = [{ x: 0, y: 0, w: 100, h: 60 }, { x: 116, y: 0, w: 100, h: 60 }, { x: 232, y: 0, w: 100, h: 60 }];
  it('drops before the nearest card over its left half', () => {
    expect(fanInsertAt(shown, { x: 130, y: 30 }, 16)).toEqual({ slot: 2, x: 108, y: 0, h: 60 });
  });
  it('drops after it over its right half', () => {
    expect(fanInsertAt(shown, { x: 200, y: 30 }, 16)).toEqual({ slot: 1, x: 224, y: 0, h: 60 });
  });
  it('is nowhere when the pointer is far from the fan', () => {
    expect(fanInsertAt(shown, { x: 160, y: 300 }, 16)).toBeNull();
  });
});

describe('reorderedPile', () => {
  it('moves a card to a slot counted from the bottom', () => {
    expect(reorderedPile(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
  });
  it('puts it on top for a slot past the end', () => {
    expect(reorderedPile(['a', 'b', 'c'], 'a', 9)).toEqual(['b', 'c', 'a']);
  });
});
