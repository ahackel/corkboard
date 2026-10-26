import { describe, it, expect } from 'vitest';
import { snapBox, type Box } from '../src/utils/guides.js';

const b = (x: number, y: number, w = 100, h = 50): Box => ({ x, y, w, h });

describe('snapBox', () => {
  it('leaves a box alone when nothing is near', () => {
    const s = snapBox(b(0, 0), [b(500, 500)], 6);
    expect([s.dx, s.dy, s.guides.length, s.gaps.length]).toEqual([0, 0, 0, 0]);
  });
  it('aligns a left edge and draws one line', () => {
    const s = snapBox(b(304, 200), [b(300, 0)], 6);
    expect(s.dx).toBe(-4);
    expect(s.guides).toContainEqual({ axis: 'x', at: 300, from: 0, to: 250 });
  });
  it('aligns centres', () => {
    const s = snapBox(b(0, 103, 100, 20), [b(300, 90, 100, 50)], 6);
    expect(s.dy).toBe(2);   // its centre, 113, onto the neighbour's, 115
  });
  it('picks the nearest pull, not the first', () => {
    expect(snapBox(b(305, 0), [b(300, 200), b(306, 400)], 6).dx).toBe(1);
  });
  it('continues the gap of a column', () => {
    // cards at y 0 and 62 (gap 12, heights 50); the dragged one at 127 is pulled to 124
    const s = snapBox(b(0, 127), [b(0, 0), b(0, 62)], 6);
    expect(s.dy).toBe(-3);
    expect(s.gaps).toEqual([{ axis: 'y', from: 50, to: 62, at: 50 }, { axis: 'y', from: 112, to: 124, at: 50 }]);
  });
  it('centres between two neighbours', () => {
    const s = snapBox(b(198, 0), [b(0, 0), b(400, 0)], 6);
    expect(s.dx).toBe(2);
    expect(s.gaps.map(g => g.to - g.from)).toEqual([100, 100]);
  });
  it('ignores boxes that do not face it for spacing', () => {
    const s = snapBox(b(0, 127), [b(500, 0), b(500, 62)], 6);
    expect(s.gaps).toEqual([]);
  });
  it('draws edges, not the centre too, for cards of one width', () => {
    const s = snapBox(b(2, 200), [b(0, 0)], 6);
    expect(s.guides.filter(g => g.axis === 'x').map(g => g.at)).toEqual([0, 100]);
  });
});
