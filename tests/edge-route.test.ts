import { describe, it, expect } from 'vitest';
import { routeFor, polyline, simplify, crosses, rimPoint, type Rect } from '../src/utils/edge-route';

const rect = (x: number, y: number, w = 100, h = 40): Rect => ({ x, y, w, h });

describe('routeFor, no pinned ends', () => {
  it('runs straight across the overlap when two cards face each other', () => {
    expect(routeFor(rect(0, 0), undefined, rect(300, 10), undefined))
      .toEqual([{ x: 100, y: 25 }, { x: 300, y: 25 }]);
  });

  it('makes a Z that turns halfway across the gap when they do not face', () => {
    const pts = routeFor(rect(0, 0), undefined, rect(300, 60), undefined);
    expect(pts).toEqual([{ x: 100, y: 20 }, { x: 200, y: 20 }, { x: 200, y: 80 }, { x: 300, y: 80 }]);
  });

  it('goes vertical when the cards are further apart up and down', () => {
    expect(routeFor(rect(0, 0), undefined, rect(20, 300), undefined))
      .toEqual([{ x: 60, y: 40 }, { x: 60, y: 300 }]);
  });

  it('falls back to a centre-to-centre line when the cards overlap outright', () => {
    const pts = routeFor(rect(0, 0), undefined, rect(50, 10), undefined);
    expect(pts).toHaveLength(2);
  });
});

describe('routeFor, pinned ends', () => {
  it('leaves a pinned face square and never crosses either card', () => {
    const a = rect(0, 0), b = rect(300, 0);
    const pts = routeFor(a, 'up', b, 'up');
    expect(pts[0]).toEqual({ x: 50, y: 0 });
    expect(pts[1].x).toBe(50);
    expect(pts[1].y).toBeLessThan(0);
    expect(pts[pts.length - 1]).toEqual({ x: 350, y: 0 });
    for (let i = 0; i < pts.length - 1; i++) {
      expect(crosses(pts[i], pts[i + 1], a) || crosses(pts[i], pts[i + 1], b)).toBe(false);
    }
  });

  it('keeps every leg orthogonal', () => {
    const pts = routeFor(rect(0, 0), 'down', rect(400, 300), 'left');
    for (let i = 0; i < pts.length - 1; i++) {
      expect(pts[i].x === pts[i + 1].x || pts[i].y === pts[i + 1].y).toBe(true);
    }
  });
});

describe('simplify', () => {
  it('drops repeated and collinear points', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]))
      .toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  });

  it('refuses a path that doubles back on itself', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }])).toBeNull();
  });
});

describe('polyline', () => {
  it('trims each end of a straight line and puts the label at its middle', () => {
    const g = polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 6, 10);
    expect(g.a).toEqual({ x: 6, y: 0 });
    expect(g.b).toEqual({ x: 90, y: 0 });
    expect(g.mid).toEqual({ x: 48, y: 0 });
    expect(g.box).toEqual({ x0: 0, y0: 0, x1: 100, y1: 0 });
  });

  it('keeps the trim on a leg too short to give it up', () => {
    const g = polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 6, 6);
    expect(g.a).toEqual({ x: 0, y: 0 });
    expect(g.b).toEqual({ x: 10, y: 0 });
  });

  it('rounds an elbow corner with a quadratic curve', () => {
    expect(polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 0, 0).d).toContain(' Q 100 0 ');
  });
});

describe('rimPoint', () => {
  it('meets the side the ray reaches first', () => {
    expect(rimPoint(rect(0, 0, 100, 40), { x: 500, y: 20 })).toEqual({ x: 100, y: 20 });
    expect(rimPoint(rect(0, 0, 100, 40), { x: 50, y: -500 })).toEqual({ x: 50, y: 0 });
  });
});
