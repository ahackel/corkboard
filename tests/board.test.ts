import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Store } from '../src/store/types.js';

// Same page shell as tests/save.test.ts: loading the board pulls in modules that wire up the page.
vi.mock('../src/boot.js', () => ({ boot: async () => {}, showStart() {}, hideStart() {} }));
document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const { state } = await import('../src/core/state.js');
const { useStore } = await import('../src/data/persistence.js');
const { loadBoard } = await import('../src/data/board.js');

function storeWithBoard(board: unknown): Store {
  return {
    isOpen: true, name: 'test',
    async pick() { return 'ok'; },
    async listTree() { return { files: [], lazy: new Map(), foreign: new Set() }; },
    async removeDir() {},
    async write() {},
    async remove() {},
    async readBlob(path) { return path === 'board.json' ? new Blob([JSON.stringify(board)]) : null; },
    watch() {},
  };
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
});
