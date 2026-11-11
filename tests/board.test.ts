import { describe, it, expect } from 'vitest';
import type { Store } from '../src/store/types.js';
import './page-shell.js';

const { state } = await import('../src/core/state.js');
const { useStore } = await import('../src/data/persistence.js');
const { loadBoard } = await import('../src/data/board.js');
const { fakeStore } = await import('./helpers.js');

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
});
