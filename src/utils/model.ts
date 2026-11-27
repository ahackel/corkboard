// Tree queries over the live `parent` links in state.nodes.
import { state, isStack, isImageCard, type MindNode } from '../core/state.js';
import { firstLineLabel } from './frontmatter.js';
import { scope } from '../nav/scope.js';
import { ui } from '../core/ui-state.js';

export function nodesOf(ids: Iterable<string>): MindNode[] {
  const out: MindNode[] = [];
  for (const id of ids) {
    const n = state.nodes.get(id);
    if (n) {
      out.push(n);
    }
  }
  return out;
}

export function nodeByFile(file: string): MindNode | undefined {
  for (const n of state.nodes.values()) {
    if (n.file === file) {
      return n;
    }
  }
  return undefined;
}

export function childrenOf(id: string | null): MindNode[] {
  if (kidIndex) {
    return kidIndex.get(id) ?? [];
  }
  return [...state.nodes.values()].filter(n => n.parent === id);
}

// childrenOf scans the whole map; `withKids` answers from ONE index for the length of `fn`. Only
// around code that READS the tree: a parent changed inside `fn` would not show.
let kidIndex: Map<string | null, MindNode[]> | null = null;

export function withKids<T>(fn: () => T): T {
  if (kidIndex) {
    return fn();
  }
  kidIndex = new Map();
  for (const n of state.nodes.values()) {
    const kids = kidIndex.get(n.parent);
    if (kids) {
      kids.push(n);
    } else {
      kidIndex.set(n.parent, [n]);
    }
  }
  try {
    return fn();
  } finally {
    kidIndex = null;
  }
}

export function parentOf(n: MindNode): MindNode | null {
  return n.parent ? state.nodes.get(n.parent) ?? null : null;
}

// Nearest first. The guard makes a corrupt parent chain a short walk instead of a hung tab.
const MAX_DEPTH = 4096;

export function* ancestors(n: MindNode): Generator<MindNode> {
  let guard = 0;
  for (let p = parentOf(n); p && guard++ < MAX_DEPTH; p = parentOf(p)) {
    yield p;
  }
}

// Those with no ancestor among the given nodes.
export function outermost(nodes: MindNode[]): MindNode[] {
  const ids = new Set(nodes.map(n => n.id));
  return nodes.filter(n => ![...ancestors(n)].some(a => ids.has(a.id)));
}

export function isRoot(n: MindNode): boolean { return !n.parent || !state.nodes.has(n.parent); }

// THE ONE VISIBILITY GATE: a folded ancestor, the open-section scope, an un-fanned stack. New terms go
// IN here. The open section is checked before any fold: while open it IS the canvas, and reaching no
// open section on the way up (incl. `n` being it) hides `n`.
export function isHidden(n: MindNode): boolean {
  const scopeId = scope.rootId;

  // Not `ancestors`: the hottest walk on the paint path keeps early returns and skips the generator.
  for (let p = parentOf(n); p; p = parentOf(p)){
    if (p.id === scopeId) {
      return false;
    }
    if (p.collapsed || (isStack(p) && ui.fan !== p.id)) {
      return true;
    }
  }
  return scopeId !== null;
}

// The visible card standing in for a hidden one: its nearest visible ancestor.
export function firstVisible(n: MindNode): MindNode {
  if (!isHidden(n)) {
    return n;
  }
  for (const p of ancestors(n)) {
    if (!isHidden(p)) {
      return p;
    }
  }

  // Only a node outside the open section has no visible ancestor; search filters those out first.
  return n;
}

// For a folded section's tooltip, including folders not yet read (MindNode.lazy).
export function heldSummary(n: MindNode): string {
  let cards = 0, sections = 0;
  subtreeIds(n.id).forEach((id, i) => {
    const m = state.nodes.get(id)!;
    if (i) {
      m.type === 'section' ? sections++ : cards++;
    }
    if (m.lazy != null) {
      sections += m.lazySections ?? 0;
      cards += m.lazy - (m.lazySections ?? 0);
    }
  });
  const part = (k: number, one: string): string => k ? `${k} ${one}${k === 1 ? '' : 's'}` : '';
  return [part(cards, 'Card'), part(sections, 'Section')].filter(Boolean).join(', ') || 'Empty';
}

export function descendantCount(id: string): number {
  let c = 0;
  for (const ch of childrenOf(id)) {
    c += 1 + descendantCount(ch.id);
  }
  return c;
}

// Such a node can't even be selected; the locked card itself still can.
export function hasLockedAncestor(n: MindNode): boolean {
  for (let p = parentOf(n); p; p = parentOf(p)) {
    if (p.locked) {
      return true;
    }
  }
  return false;
}

// Protected from move, fold, edit and delete.
export function isLockedEffective(n: MindNode): boolean { return n.locked || hasLockedAncestor(n); }

// THE answer for every drop INTO a card's note (merge, text, picture): a plain unlocked card. An image
// card IS its picture, so adding to it would end that.
export function takesDrop(n: MindNode | null | undefined): n is MindNode {
  return !!n && n.type === 'card' && !isImageCard(n) && !isLockedEffective(n);
}

export function subtreeHasLocked(id: string): boolean {
  const n = state.nodes.get(id);
  if (n?.locked) {
    return true;
  }
  return childrenOf(id).some(ch => subtreeHasLocked(ch.id));
}

// The name to SHOW for a node where the card itself isn't: never written, never matched on.
export function nodeLabel(n: MindNode): string {
  return n.title.trim() || firstLineLabel(n.body) || namelessLabel(n);
}

const hasNoTextToName = (n: MindNode): boolean => !n.title.trim() && !firstLineLabel(n.body);

// "No-title N", POSITIONAL in map order: never the filename stem, which for a cleared card is the very
// name the user just deleted.
function namelessLabel(n: MindNode): string {
  let i = 0;
  for (const o of state.nodes.values()){
    if (hasNoTextToName(o)) {
      i++;
    }
    if (o.id === n.id) {
      break;
    }
  }
  return `No-title ${i || 1}`;   // a node still being created isn't in state.nodes yet
}

// Labels worn by more than one node; built once per LIST and passed to disambiguatedLabel.
export function duplicateLabels(): Set<string> {
  const seen = new Set<string>(), dup = new Set<string>();
  for (const o of state.nodes.values()){
    const l = nodeLabel(o);
    if (seen.has(l)) {
      dup.add(l);
    } else {
      seen.add(l);
    }
  }
  return dup;
}

// Only an ambiguous label gets its parent appended (for flat lists like search hits).
export function disambiguatedLabel(n: MindNode, dup: Set<string> = duplicateLabels()): string {
  const label = nodeLabel(n);
  if (!dup.has(label)) {
    return label;
  }
  const p = parentOf(n);
  return p ? `${label} — ${nodeLabel(p)}` : label;
}

// Guards against cycles when re-parenting.
export function isAncestor(maybeAncestorId: string, nodeId: string): boolean {
  const n = state.nodes.get(nodeId);
  if (!n) {
    return false;
  }
  for (const p of ancestors(n)) {
    if (p.id === maybeAncestorId) {
      return true;
    }
  }
  return false;
}

// `#heading`/`^block` is a place IN the note and `.md` is optional, as in Obsidian.
export function linkName(name: string): string {
  return name.replace(/[#^].*$/, '').trim().replace(/\.md$/i, '');
}

// Exact path, then a path tail (`[[Notes]]` for `Ideas/Notes.md`), then title; in map order. Shared by
// the click and the link lines, so a line never points where the click doesn't go.
export function resolveWikilink(name: string): MindNode[] {
  const t = linkName(name).toLowerCase();
  if (!t) {
    return [];
  }
  const nodes = [...state.nodes.values()];
  const file = (n: MindNode): string => (n.file ?? '').toLowerCase();
  const byFile = nodes.filter(n => file(n) === t + '.md');
  if (byFile.length) {
    return byFile;
  }
  const byTail = nodes.filter(n => file(n).endsWith('/' + t + '.md'));
  return byTail.length ? byTail : nodes.filter(n => n.title.trim().toLowerCase() === t);
}

// The node whose card holds `t` (an event target, or what is under a point).
export function nodeAtTarget(t: EventTarget | null | undefined): MindNode | null {
  const el = t instanceof Element ? t.closest<HTMLElement>('#world [data-id]') : null;
  return el ? state.nodes.get(el.dataset.id ?? '') ?? null : null;
}

export function subtreeIds(id: string): string[] {
  const out = [id];
  for (const ch of childrenOf(id)) {
    out.push(...subtreeIds(ch.id));
  }
  return out;
}
