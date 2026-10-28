// Build a MindNode from a parsed note the way data/load.ts loadFromDir does, minus geometry.
import { parseMd } from '../src/utils/frontmatter.js';
import { state, type MindNode } from '../src/core/state.js';

export function nodeFrom(text: string, file: string | null = 'Note.md', id = 'n' + state.nodes.size): MindNode {
  const p = parseMd(text);
  const n: MindNode = {
    id, file, x: 0, y: 0, rx: 0, ry: 0, parent: null,
    collapsed: p.mm.collapsed, locked: p.mm.locked, type: p.mm.type,
    title: p.title, color: p.color, keepStatus: p.keepStatus, tags: p.tags, body: p.body,
    titleGap: p.titleGap, fmEntries: p.fmEntries, dirty: false, dirtyLayout: false,
  };
  state.nodes.set(id, n);
  return n;
}
