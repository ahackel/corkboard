// Build a MindNode from a parsed note the way data/load.ts loadFromDir does, minus geometry.
import { parseMd } from '../src/utils/frontmatter.js';
import { state, type MindNode } from '../src/core/state.js';
import type { Store } from '../src/store/types.js';

// A store that holds nothing and does nothing; a test overrides the calls it cares about.
export function fakeStore(over: Partial<Store> = {}): Store {
  return {
    isOpen: true, name: 'test',
    async pick() { return 'ok'; },
    async listTree() { return { files: [], lazy: new Map(), foreign: new Set() }; },
    async removeDir() {},
    async write() {},
    async remove() {},
    async readBlob() { return null; },
    watch() {},
    ...over,
  };
}

export function nodeFrom(text: string, file: string | null = 'Note.md', id = 'n' + state.nodes.size): MindNode {
  const p = parseMd(text);
  const n: MindNode = {
    id, file, x: 0, y: 0, rx: 0, ry: 0, parent: null,
    collapsed: p.mm.collapsed, locked: p.mm.locked, type: p.mm.type,
    title: p.title, color: p.color, keepStatus: p.keepStatus, tags: p.tags, body: p.body,
    titleGap: p.titleGap, titleLevel: p.titleLevel, fmEntries: p.fmEntries, dirty: false, dirtyLayout: false,
  };
  state.nodes.set(id, n);
  return n;
}
