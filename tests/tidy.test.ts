import { describe, it, expect } from 'vitest';
import { rowsOf, tidyGrid, align, distribute, type Box } from '../src/utils/tidy';

const box = (id: string, x: number, y: number, w = 100, h = 40): Box => ({ id, x, y, w, h });
const at = (m: Map<string, { x: number; y: number }>, id: string) => m.get(id);

describe('rowsOf', () => {
  it('keeps a messy column a column, even when the cards overlap a little', () => {
    const rows = rowsOf([box('a', 0, 0), box('b', 6, 35), box('c', -4, 90)]);
    expect(rows.map(r => r.map(b => b.id))).toEqual([['a'], ['b'], ['c']]);
  });
  it('keeps a taller, lower card in the row it sits beside', () => {
    // a two-line note hanging a little below its neighbours, then a second row underneath
    const rows = rowsOf([box('a', 0, 0, 180, 44), box('b', 230, 37, 180, 62), box('c', 480, 0, 180, 44),
                         box('d', 20, 200), box('e', 240, 190), box('f', 470, 210, 180, 80)]);
    expect(rows.map(r => r.map(b => b.id))).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']]);
  });
  it('keeps a drifting row a row, ordered left to right', () => {
    const rows = rowsOf([box('b', 200, 12), box('a', 0, 0), box('c', 400, -8)]);
    expect(rows.map(r => r.map(b => b.id))).toEqual([['a', 'b', 'c']]);
  });
});

describe('tidyGrid', () => {
  it('lines a row up with even gaps from the selection’s top-left', () => {
    const m = tidyGrid([box('a', 10, 5), box('b', 130, 20, 80), box('c', 300, 0)], 20);
    expect(at(m, 'a')).toEqual({ x: 10, y: 0 });
    expect(at(m, 'b')).toEqual({ x: 130, y: 0 });
    expect(at(m, 'c')).toEqual({ x: 230, y: 0 });   // 130 + b's column (80) + 20
  });
  it('stacks a column with even gaps, left-aligned', () => {
    const m = tidyGrid([box('a', 0, 0, 100, 60), box('b', 15, 100), box('c', -5, 300)], 20);
    expect(at(m, 'a')).toEqual({ x: -5, y: 0 });
    expect(at(m, 'b')).toEqual({ x: -5, y: 80 });
    expect(at(m, 'c')).toEqual({ x: -5, y: 140 });
  });
  it('makes a grid whose columns are as wide as their widest card', () => {
    const m = tidyGrid([box('a', 0, 0, 150), box('b', 200, 0), box('c', 0, 100), box('d', 210, 95)], 20);
    expect(at(m, 'b')).toEqual({ x: 170, y: 0 });
    expect(at(m, 'd')).toEqual({ x: 170, y: 60 });
  });
});

describe('align / distribute', () => {
  it('aligns on one axis only', () => {
    const m = align([box('a', 0, 0), box('b', 50, 80, 200)], 'right');
    expect(at(m, 'a')).toEqual({ x: 150, y: 0 });
    expect(at(m, 'b')).toEqual({ x: 50, y: 80 });
  });
  it('centres on the selection’s middle', () => {
    expect(at(align([box('a', 0, 0, 100, 40), box('b', 0, 100, 100, 100)], 'middle'), 'a')).toEqual({ x: 0, y: 80 });
  });
  it('evens the gaps, keeping the outer two and the order', () => {
    const m = distribute([box('a', 0, 0), box('c', 500, 0), box('b', 130, 0)], 'x');
    expect(at(m, 'a')).toEqual({ x: 0, y: 0 });
    expect(at(m, 'b')).toEqual({ x: 250, y: 0 });
    expect(at(m, 'c')).toEqual({ x: 500, y: 0 });
  });
  it('leaves two boxes alone', () => {
    const m = distribute([box('a', 0, 0), box('b', 300, 0)], 'x');
    expect(at(m, 'b')).toEqual({ x: 300, y: 0 });
  });
});
