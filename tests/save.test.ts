import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Store } from '../src/store/types.js';

// Booting the app opens IndexedDB, which the test DOM lacks — and a save never needs it.
vi.mock('../src/boot.js', () => ({ boot: async () => {}, showStart() {}, hideStart() {} }));
// The save pulls in modules that wire up the page as they load, so they need its shell first.
document.body.innerHTML = readFileSync('index.html', 'utf8').replace(/^[\s\S]*<body[^>]*>|<\/body>[\s\S]*$/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');
const { state } = await import('../src/core/state.js');
const { useStore } = await import('../src/data/persistence.js');
const { flushSave } = await import('../src/data/save.js');
const { nodeFrom } = await import('./helpers.js');

// A folder the way macOS and Windows see one: `Notes.md` and `notes.md` are the same file.
function caseInsensitiveStore(): Store & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files, isOpen: true, name: 'test',
    async pick() { return 'ok'; },
    async listTree() { return { files: [], lazy: new Map(), foreign: new Set() }; },
    async removeDir() {},
    async write(path, data) { files.set(path.toLowerCase(), String(data)); },
    async remove(path) { files.delete(path.toLowerCase()); },
    async readBlob() { return null; },
    watch() {},
  };
}

describe('saveAll', () => {
  beforeEach(() => { state.nodes.clear(); state.toDelete = []; });

  it('keeps a note whose title only changed case', async () => {
    const store = caseInsensitiveStore();
    useStore(store);
    store.files.set('notes.md', '# notes');
    const n = nodeFrom('# Notes', 'notes.md');
    n.dirty = true;
    await flushSave();
    expect(store.files.get('notes.md')).toContain('# Notes');
  });
});
