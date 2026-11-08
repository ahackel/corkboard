import { describe, it, expect, beforeEach } from 'vitest';
import type { Store } from '../src/store/types.js';
import './page-shell.js';

const { state } = await import('../src/core/state.js');
const { useStore } = await import('../src/data/persistence.js');
const { flushSave } = await import('../src/data/save.js');
const { nodeFrom, fakeStore } = await import('./helpers.js');

// A folder the way macOS and Windows see one: `Notes.md` and `notes.md` are the same file.
function caseInsensitiveStore(): Store & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    ...fakeStore({
      async write(path, data) { files.set(path.toLowerCase(), String(data)); },
      async remove(path) { files.delete(path.toLowerCase()); },
    }),
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

  // A stack is a section drawn as a pile: the folder is the same, and the pile is board.json's to say.
  it('writes a stack as a section folder, flagged `stack` in board.json, its pile order with it', async () => {
    const store = caseInsensitiveStore();
    useStore(store);
    const s = nodeFrom('', null);
    s.type = 'section'; s.stack = true;
    const a = nodeFrom('# Alpha', null), b = nodeFrom('# Beta', null);
    a.parent = s.id; b.parent = s.id;
    s.kidOrder = [b.id, a.id];
    for (const n of [s, a, b]) {
      n.dirty = true;
    }
    await flushSave();
    expect([...store.files.keys()]).toEqual(expect.arrayContaining(['stack/_index.md', 'stack/alpha.md', 'stack/beta.md']));
    const board = JSON.parse(store.files.get('board.json')!);
    expect(board.nodes['Stack/_index.md']).toMatchObject({ stack: true, order: ['Stack/Beta.md', 'Stack/Alpha.md'] });
    expect(board.nodes['Stack/Alpha.md'].stack).toBeUndefined();
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
