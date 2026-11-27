import { describe, it, expect } from 'vitest';
import { gridDelta, edgePanVelocity } from '../src/utils/drag-geometry.js';

describe('gridDelta', () => {
  it('puts the anchor card on the grid, rounding to the nearest line', () => {
    expect(gridDelta({ x: 0, y: 0 }, { x: 29, y: 31 }, { x: 0, y: 0 }, 20)).toEqual({ x: 20, y: 40 });
  });
  it('corrects an off-grid start too, so the card ends ON the grid', () => {
    const d = gridDelta({ x: 7, y: 3 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 20);
    expect({ x: 7 + d.x, y: 3 + d.y }).toEqual({ x: 0, y: 0 });
  });
  it('snaps a card in a section to the section’s own corner', () => {
    const d = gridDelta({ x: 115, y: 215 }, { x: 22, y: 0 }, { x: 105, y: 205 }, 20);
    expect({ x: 115 + d.x, y: 215 + d.y }).toEqual({ x: 145, y: 225 });
  });
  it('passes the delta through with the grid off', () => {
    expect(gridDelta({ x: 3, y: 4 }, { x: 13.5, y: -2.25 }, { x: 0, y: 0 }, 1)).toEqual({ x: 13.5, y: -2.25 });
  });
});

describe('edgePanVelocity', () => {
  const stage = { left: 0, top: 0, right: 1000, bottom: 800 };
  it('stays still away from the edges', () => {
    expect(edgePanVelocity({ x: 500, y: 400 }, stage, 56, 16)).toEqual({ x: 0, y: 0 });
  });
  it('ramps in across the band and tops out at the edge', () => {
    expect(edgePanVelocity({ x: 28, y: 400 }, stage, 56, 16)).toEqual({ x: 8, y: 0 });
    expect(edgePanVelocity({ x: -40, y: 400 }, stage, 56, 16)).toEqual({ x: 16, y: 0 });
  });
  it('pans the other way at the right and bottom edges, both axes at a corner', () => {
    expect(edgePanVelocity({ x: 1000, y: 800 }, stage, 56, 16)).toEqual({ x: -16, y: -16 });
  });
});
