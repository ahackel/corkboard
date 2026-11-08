import { describe, it, expect, beforeEach } from 'vitest';
import type { Store } from '../src/store/types.js';
import './page-shell.js';

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

  it('never deletes a note that took a renamed one’s name in another case', async () => {
    const store = caseInsensitiveStore();
    useStore(store);
    store.files.set('plan.md', '# Plan');
    store.files.set('b.md', '# b');
    const a = nodeFrom('# Other', 'Plan.md', 'a');
    const b = nodeFrom('# plan', 'b.md', 'b');
    a.dirty = true; b.dirty = true;
    await flushSave();
    expect(store.files.get(a.file!.toLowerCase())).toContain('# Other');
    expect(store.files.get(b.file!.toLowerCase())).toContain('# plan');
    // the next save, with the old name free, gives it the plain name
    b.dirty = true;
    await flushSave();
    expect(b.file).toBe('plan.md');
    expect(store.files.get('plan.md')).toContain('# plan');
  });

  it('a rename moves the file and carries the links that point at it', async () => {
    const store = caseInsensitiveStore();
    useStore(store);
    store.files.set('old.md', '# Old');
    store.files.set('ref.md', '# Ref\nsee [[old]]');
    const n = nodeFrom('# New', 'old.md', 'n');
    nodeFrom('# Ref\nsee [[old]]', 'ref.md', 'r');
    n.dirty = true;
    await flushSave();
    expect(store.files.has('old.md')).toBe(false);
    expect(store.files.get('new.md')).toContain('# New');
    expect(store.files.get('ref.md')).toContain('[[New]]');
  });
});
