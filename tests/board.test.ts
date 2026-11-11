import { describe, it, expect } from 'vitest';
import type { Store } from '../src/store/types.js';
import './page-shell.js';

const { state } = await import('../src/core/state.js');
const { useStore } = await import('../src/data/persistence.js');
const { loadBoard, boardJSON, resolveEdges, flushBoard } = await import('../src/data/board.js');
const { writesHeld } = await import('../src/data/save-alert.js');
const { flushSave } = await import('../src/data/save.js');
const { fakeStore, nodeFrom } = await import('./helpers.js');

function storeWithBoard(board: unknown): Store {
  return fakeStore({ async readBlob(path) { return path === 'board.json' ? new Blob([JSON.stringify(board)]) : null; } });
}

describe('loadBoard', () => {
  it('replaces a line id that could break out of markup, and drops bad styles', async () => {
    useStore(storeWithBoard({ model: 2, edges: [
      { id: 'x"><image href=x onerror=alert(1)>', from: 'A.md', to: 'B.md', color: 'red;}', fromCap: 'boom' },
      { id: 'e-ok_1', from: 'A.md', to: 'B.md', toCap: 'dot' },
    ] }));
    await loadBoard();
    const [bad, good] = state.edges;
    expect(bad.id).toMatch(/^[\w-]+$/);
    expect(bad.color).toBe('');
    expect(bad.fromCap).toBe('none');
    expect(good.id).toBe('e-ok_1');
    expect(good.toCap).toBe('dot');
  });

  it('reads the old single `arrows` field as caps', async () => {
    useStore(storeWithBoard({ model: 2, edges: [{ id: 'e1', from: 'A.md', to: 'B.md', arrows: 'both' }] }));
    await loadBoard();
    expect(state.edges[0]).toMatchObject({ fromCap: 'arrow', toCap: 'arrow' });
  });

  it('keeps a shifted end only on a pinned face, and only within it', async () => {
    useStore(storeWithBoard({ model: 2, edges: [
      { id: 'e1', from: 'A.md', to: 'B.md', fromPort: 'right', fromAt: 0.25, toPort: 'left', toAt: 1.5 },
      { id: 'e2', from: 'A.md', to: 'B.md', fromAt: 0.25 },
    ] }));
    await loadBoard();
    expect(state.edges[0].fromAt).toBe(0.25);
    expect(state.edges[0].toAt).toBeUndefined();
    expect(state.edges[1].fromAt).toBeUndefined();
  });

  it('does not take an inherited name for a canvas colour', async () => {
    useStore(storeWithBoard({ model: 2, settings: { canvasColor: 'constructor' } }));
    await loadBoard();
    expect(state.canvasColor).toBe('');
  });

  it('puts a board file it cannot read aside before anything writes over it', async () => {
    const written = new Map<string, string>();
    useStore(fakeStore({
      async readBlob(path) { return path === 'board.json' ? new Blob(['{"model":2,"nodes":{"A.md":{"x":1']) : null; },
      async write(path, data) { written.set(path, String(data)); },
    }));
    await loadBoard();
    const [name] = [...written.keys()];
    expect(name).toMatch(/^board\.unreadable-\d{8}-\d{6}\.json$/);
    expect(written.get(name)).toBe('{"model":2,"nodes":{"A.md":{"x":1');
  });

  it('writes back what a newer build put there and this one has no name for', async () => {
    useStore(storeWithBoard({ version: 1, model: 2, pinned: ['A.md'], settings: { grid: 'dot', theme: 'paper' },
      edges: [{ id: 'e1', from: 'A.md', to: 'B.md', weight: 3 }], nodes: { 'A.md': { x: 1, y: 2, z: 9 } } }));
    await loadBoard();
    nodeFrom('# A', 'A.md', 'a'); nodeFrom('# B', 'B.md', 'b');
    resolveEdges(new Map([['A.md', 'a'], ['B.md', 'b']]));
    const out = JSON.parse(boardJSON());
    expect(out.pinned).toEqual(['A.md']);
    expect(out.settings.theme).toBe('paper');
    expect(out.edges[0].weight).toBe(3);
    expect(out.nodes['A.md'].z).toBe(9);
    state.nodes.clear();
  });

  it('holds every write on a map saved by a newer build, and says so', async () => {
    const written: string[] = [];
    useStore(fakeStore({
      async readBlob(path) { return path === 'board.json' ? new Blob([JSON.stringify({ version: 2, model: 2 })]) : null; },
      async write(path) { written.push(path); },
    }));
    await loadBoard();
    expect(writesHeld()).toBe(true);
    expect(document.getElementById('saveAlert')!.hidden).toBe(false);
    const n = nodeFrom('# New', null, 'n');
    n.dirty = true;
    await flushSave();
    await flushBoard();
    expect(written).toEqual([]);
    state.nodes.clear();
    useStore(storeWithBoard({ version: 1, model: 2 }));
    await loadBoard();
    expect(writesHeld()).toBe(false);
  });
});

