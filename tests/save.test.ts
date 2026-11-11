import { describe, it, expect, beforeEach } from 'vitest';
import type { Store } from '../src/store/types.js';
import './page-shell.js';

const { state } = await import('../src/core/state.js');
const { useStore } = await import('../src/data/persistence.js');
const { flushSave, noteNamed, resetSaveState } = await import('../src/data/save.js');
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
  beforeEach(() => { state.nodes.clear(); state.toDelete = []; resetSaveState(); });

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

// A folder the way macOS sees one: case folds, and so do the two spellings of an accented letter.
function foldingStore(): Store & { files: Map<string, string> } {
  const files = new Map<string, string>(), key = (p: string): string => p.normalize('NFC').toLowerCase();
  return {
    files,
    ...fakeStore({
      async write(path, data) { files.set(key(path), String(data)); },
      async remove(path) { files.delete(key(path)); },
      async readBlob(path) { return files.has(key(path)) ? new Blob([files.get(key(path))!]) : null; },
    }),
  };
}

describe('saveAll never loses a note to its filename', () => {
  beforeEach(() => { state.nodes.clear(); state.toDelete = []; resetSaveState(); });

  it('keeps a note whose file spells its accent the other way', async () => {
    const store = foldingStore();
    useStore(store);
    store.files.set('caf\u00e9.md', '# Caf\u00e9');
    const n = nodeFrom('# Caf\u00e9\n\nedited', 'Cafe\u0301.md');
    n.dirty = true;
    await flushSave();
    expect(n.file).toBe('Cafe\u0301.md');
    expect(store.files.get('caf\u00e9.md')).toContain('edited');
  });

  it('does not write a new card over a file it never loaded', async () => {
    const store = foldingStore();
    useStore(store);
    store.files.set('idea.md', 'written by another app');
    const n = nodeFrom('# Idea', null);
    n.dirty = true;
    await flushSave();
    expect(store.files.get('idea.md')).toBe('written by another app');
    expect(n.file).toBe('Idea 2.md');
    expect(store.files.get('idea 2.md')).toContain('# Idea');
  });

  it('does not rename a note over a file it never loaded', async () => {
    const store = foldingStore();
    useStore(store);
    store.files.set('old.md', '# Old');
    store.files.set('shopping.md', 'another tab wrote this');
    const n = nodeFrom('# Shopping', 'old.md');
    n.dirty = true;
    await flushSave();
    expect(store.files.get('shopping.md')).toBe('another tab wrote this');
    expect(store.files.get('shopping 2.md')).toContain('# Shopping');
  });

  it('saves the other notes when one cannot be written, and keeps that one’s old file', async () => {
    const store = foldingStore();
    const write = store.write.bind(store);
    store.write = async (path, data) => {
      if (path.startsWith('Bad')) {
        throw new Error('name too long');
      }
      await write(path, data);
    };
    useStore(store);
    store.files.set('old.md', '# Old');
    const bad = nodeFrom('# Bad name', 'old.md', 'bad');
    const good = nodeFrom('# Good', null, 'good');
    bad.dirty = true; good.dirty = true;
    await flushSave();
    expect(store.files.get('good.md')).toContain('# Good');
    expect(store.files.get('old.md')).toBe('# Old');
    expect(bad.dirty).toBe(true);
    expect(document.getElementById('saveAlert')!.hidden).toBe(false);
  });
});

describe('a file keeps the name it came with until its text changes', () => {
  beforeEach(() => { state.nodes.clear(); state.toDelete = []; resetSaveState(); });

  it('leaves a name that says something else than the note alone', async () => {
    const store = foldingStore();
    useStore(store);
    store.files.set('2026-11-11.md', 'Meeting notes');
    const n = nodeFrom('Meeting notes', '2026-11-11.md');
    noteNamed('2026-11-11.md', 'Meeting notes');
    n.color = 'blue'; n.dirty = true;
    await flushSave();
    expect(n.file).toBe('2026-11-11.md');
    expect(store.files.get('2026-11-11.md')).toContain('color: blue');
  });

  it('renames it once the text that names it is edited', async () => {
    const store = foldingStore();
    useStore(store);
    store.files.set('2026-11-11.md', 'Meeting notes');
    const n = nodeFrom('Meeting notes', '2026-11-11.md');
    noteNamed('2026-11-11.md', 'Meeting notes');
    n.body = 'Planning'; n.dirty = true;
    await flushSave();
    expect(n.file).toBe('Planning.md');
    expect(store.files.has('2026-11-11.md')).toBe(false);
  });
});
