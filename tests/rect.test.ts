import { describe, it, expect } from 'vitest';
import { contains, encloses, centreOf, inflate, unionRect, deepestAt, type Rect } from '../src/utils/rect.js';

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe('contains / encloses', () => {
  it('counts a point on the border as inside', () => {
    expect(contains(r(0, 0, 100, 50), { x: 100, y: 50 })).toBe(true);
    expect(contains(r(0, 0, 100, 50), { x: 100.5, y: 0 })).toBe(false);
  });
  it('encloses a box only when all of it is inside', () => {
    expect(encloses(r(0, 0, 100, 100), r(10, 10, 90, 90))).toBe(true);
    expect(encloses(r(0, 0, 100, 100), r(10, 10, 91, 50))).toBe(false);
  });
  it('finds the centre and grows a box on every side', () => {
    expect(centreOf(r(10, 20, 100, 40))).toEqual({ x: 60, y: 40 });
    expect(inflate(r(10, 20, 100, 40), 5)).toEqual(r(5, 15, 110, 50));
  });
});

describe('unionRect', () => {
  it('bounds every box', () => {
    expect(unionRect([r(0, 10, 50, 50), r(100, -20, 20, 20)])).toEqual(r(0, -20, 120, 80));
  });
  it('is empty (infinite) for nothing', () => {
    expect(isFinite(unionRect([]).x)).toBe(false);
  });
});

describe('deepestAt', () => {
  const items = [
    { id: 'outer', box: r(0, 0, 400, 400), depth: 0 },
    { id: 'inner', box: r(100, 100, 100, 100), depth: 1 },
    { id: 'innermost', box: r(120, 120, 40, 40), depth: 2 },
  ];
  const at = (x: number, y: number, list = items): string | undefined =>
    deepestAt(list, { x, y }, t => t.box, t => t.depth)?.id;

  it('picks the innermost of nested boxes under the point', () => {
    expect(at(130, 130)).toBe('innermost');
    expect(at(110, 190)).toBe('inner');
    expect(at(10, 10)).toBe('outer');
    expect(at(500, 500)).toBeUndefined();
  });
  it('does not depend on the order the boxes come in', () => {
    expect(at(130, 130, [...items].reverse())).toBe('innermost');
  });
  it('keeps the first of two at the same depth', () => {
    const twins = [{ id: 'a', box: r(0, 0, 50, 50), depth: 1 }, { id: 'b', box: r(0, 0, 50, 50), depth: 1 }];
    expect(at(10, 10, twins)).toBe('a');
  });
  it('skips an item whose box is null', () => {
    expect(deepestAt(items, { x: 130, y: 130 }, t => t.id === 'innermost' ? null : t.box, t => t.depth)?.id).toBe('inner');
  });
});
