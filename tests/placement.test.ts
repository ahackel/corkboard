import { describe, it, expect } from 'vitest';
import { fitAround, nextInRow, belowContents, pasteShift } from '../src/utils/placement.js';

const MIN = { w: 200, h: 120 };

describe('fitAround', () => {
  it('pads the contents on every side, its corners on the grid', () => {
    expect(fitAround({ x0: 103, y0: 98, x1: 503, y1: 402 }, 16, 20, MIN)).toEqual({ x: 80, y: 80, w: 440, h: 340 });
  });
  it('never fits smaller than the section minimum', () => {
    expect(fitAround({ x0: 0, y0: 0, x1: 50, y1: 30 }, 16, 20, MIN)).toEqual({ x: -20, y: -20, w: 200, h: 120 });
  });
  it('rounds to whole pixels with the grid off', () => {
    expect(fitAround({ x0: 10.4, y0: 0, x1: 300.2, y1: 200 }, 16, 1, MIN)).toEqual({ x: -6, y: -16, w: 322, h: 232 });
  });
  it('has nothing to fit round an empty section', () => {
    expect(fitAround({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }, 16, 20, MIN)).toBeNull();
  });
});

describe('nextInRow (the smart duplicate)', () => {
  const src = { x: 300, y: 0, w: 100, h: 50 };
  it('keeps the gap the row already has from its left neighbour', () => {
    expect(nextInRow(src, [{ x: 160, y: 10, w: 100, h: 50 }], 20)).toEqual({ x: 440, y: 0 });
  });
  it('uses the default gap with no left neighbour', () => {
    expect(nextInRow(src, [], 20)).toEqual({ x: 420, y: 0 });
  });
  it('ignores a card that is not in the row', () => {
    expect(nextInRow(src, [{ x: 0, y: 200, w: 100, h: 50 }], 20)).toEqual({ x: 420, y: 0 });
  });
  it('slides past what already sits in the next slot', () => {
    expect(nextInRow(src, [{ x: 420, y: 0, w: 100, h: 50 }], 20)).toEqual({ x: 540, y: 0 });
  });
});

describe('belowContents', () => {
  const interior = { x: 100, y: 100, w: 400, h: 300 };
  it('starts an empty section at its top-left corner', () => {
    expect(belowContents(interior, [], 20)).toEqual({ x: 120, y: 120 });
  });
  it('goes under the lowest card', () => {
    expect(belowContents(interior, [{ x: 120, y: 120, w: 100, h: 60 }, { x: 300, y: 150, w: 100, h: 80 }], 20))
      .toEqual({ x: 120, y: 250 });
  });
});

describe('pasteShift', () => {
  it('moves the copied cards’ top-left to the target, plus the nudge', () => {
    expect(pasteShift({ x: 500, y: 500 }, [{ x: 100, y: 40 }, { x: 60, y: 80 }], 16)).toEqual({ x: 456, y: 476 });
  });
  it('only nudges cards that carry no position', () => {
    expect(pasteShift({ x: 500, y: 500 }, [{ x: null, y: null }, {}], 16)).toEqual({ x: 16, y: 16 });
  });
});
