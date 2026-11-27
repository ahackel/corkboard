// The drop rule over a real model: a card belongs to the innermost section its centre is in, else the top
// level; a section takes in what it covers (CLAUDE.md, "a drop lands in the innermost section…").
import { describe, it, expect, beforeEach } from 'vitest';
import './page-shell.js';

const { state } = await import('../src/core/state.js');
const { sectionAt, centreInSection } = await import('../src/view/layout.js');
const { settleSections } = await import('../src/features/drop.js');
const { nodeFrom } = await import('./helpers.js');

function section(id: string, x: number, y: number, w: number, h: number, parent: string | null = null) {
  const n = nodeFrom('# ' + id, id + '/_index.md', id);
  Object.assign(n, { type: 'section', x, y, w, h, parent });
  return n;
}

function card(id: string, x: number, y: number, parent: string | null = null) {
  const n = nodeFrom('# ' + id, id + '.md', id);
  Object.assign(n, { x, y, w: 200, parent });
  return n;
}

describe('sectionAt', () => {
  beforeEach(() => {
    state.nodes.clear();
    section('outer', 0, 0, 800, 600);
    section('inner', 100, 100, 300, 300, 'outer');
  });

  it('finds the innermost section under the point', () => {
    expect(sectionAt(150, 150, new Set())?.id).toBe('inner');
    expect(sectionAt(600, 500, new Set())?.id).toBe('outer');
    expect(sectionAt(900, 50, new Set())).toBeNull();
  });
  it('lets a drop over a locked section fall through to the one around it', () => {
    state.nodes.get('inner')!.locked = true;
    expect(sectionAt(150, 150, new Set())?.id).toBe('outer');
  });
  it('skips the cards being dragged — a section never lands in itself', () => {
    expect(sectionAt(150, 150, new Set(['inner']))?.id).toBe('outer');
  });
  it('ignores a folded section: it has no box to hold anything', () => {
    state.nodes.get('inner')!.collapsed = true;
    expect(sectionAt(150, 150, new Set())?.id).toBe('outer');
  });
  it('judges a card by its centre', () => {
    const c = card('c', 350, 100, 'inner');   // 200 wide: the centre, x 450, is outside `inner`
    expect(centreInSection(c, state.nodes.get('inner')!)).toBe(false);
    expect(centreInSection(c, state.nodes.get('outer')!)).toBe(true);
  });
});

describe('settleSections', () => {
  beforeEach(() => { state.nodes.clear(); });

  it('takes in the cards it now covers and lets go of the ones it no longer does', () => {
    const s = section('s', 0, 0, 400, 300);
    const inside = card('inside', 50, 50);
    const left = card('left', 500, 50, 's');
    expect(settleSections([s.id]).sort()).toEqual(['inside', 'left']);
    expect(inside.parent).toBe('s');
    expect(left.parent).toBeNull();
  });
  it('leaves a card in a smaller section inside it where it is', () => {
    const s = section('s', 0, 0, 800, 600);
    section('small', 100, 100, 300, 300);
    const c = card('c', 150, 150, 'small');
    settleSections([s.id]);
    expect(c.parent).toBe('small');
    expect(state.nodes.get('small')!.parent).toBe('s');
  });
  it('collects a section only when the whole box is inside', () => {
    const s = section('s', 0, 0, 400, 300);
    const big = section('big', 100, 100, 600, 100);   // its centre is in `s`, its box is not
    settleSections([s.id]);
    expect(big.parent).toBeNull();
  });
  it('never moves a locked card', () => {
    const s = section('s', 0, 0, 400, 300);
    const c = card('c', 50, 50);
    c.locked = true;
    settleSections([s.id]);
    expect(c.parent).toBeNull();
  });
});
