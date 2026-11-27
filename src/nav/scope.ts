// The scope model: which section is OPEN (the canvas is its interior). Actions live in nav/sections.ts.
// Not part of `state`: that is the MAP; a scope is where you are standing, never written to disk.
import { state, isStack, type MindNode, type View } from '../core/state.js';

export interface ScopeBack { view: View; sel: string[]; selId: string | null; }
export interface ScopeLevel {
  rootId: string;
  file: string | null;                                   // its identity across a reload
  rect: { x: number; y: number; w: number; h: number };   // the frozen viewport rect, world coords
  // null: a level nobody stepped through (from the URL, or an ancestor), so leaving it re-fits.
  back: ScopeBack | null;
}

// `rootId` mirrors the top level's: isHidden reads it for every node on every paint.
export const scope: { rootId: string | null; stack: ScopeLevel[]; pruned: boolean } =
  { rootId: null, stack: [], pruned: false };

export function scopeActive(): boolean { return scope.rootId !== null; }
export function scopeRootNode(): MindNode | null {
  return scope.rootId ? state.nodes.get(scope.rootId) ?? null : null;
}
export function isScopeRoot(n: MindNode): boolean { return n.id === scope.rootId; }
export function scopeRootFile(): string | null { return scopeRootNode()?.file ?? null; }

// Raw `type`, not isSection: a folded section is openable. A stack fans out instead.
export function canOpen(n: MindNode | null | undefined): boolean {
  return n?.type === 'section' && !isStack(n);
}
// canOpen stays true for the section you're in: the scope stack checks the path, the open one included.
export const canEnter = (n: MindNode | null | undefined): boolean => canOpen(n) && !isScopeRoot(n!);

// isHidden's scope term on its own, for callers that must tell it from "folded away".
export function outOfScope(n: MindNode): boolean {
  const id = scope.rootId;
  if (id === null) {
    return false;
  }
  for (let p = n.parent ? state.nodes.get(n.parent) : undefined; p; p = p.parent ? state.nodes.get(p.parent) : undefined) {
    if (p.id === id) {
      return false;
    }
  }
  return true;
}

// A snapshot of the viewport (see scopeRectFor in nav/sections.ts).
export function scopeRect(): { x: number; y: number; w: number; h: number } {
  const top = scope.stack[scope.stack.length - 1];
  return top ? top.rect : { x: 0, y: 0, w: 0, h: 0 };
}

// What "no parent" means right now: inside an open section a true root would vanish off screen.
export function detachParentId(): string | null { return scope.rootId; }

// The openable ancestors of `t`, outermost first, excluding t: the crumb path.
export function openPathTo(t: MindNode): MindNode[] {
  const out: MindNode[] = [];
  for (let p = t.parent ? state.nodes.get(t.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null) {
    if (canOpen(p)) {
      out.push(p);
    }
  }
  return out.reverse();
}

// A load re-mints ids: re-resolve each level by FILE, truncating at the first miss (all of it on another
// map). Not cleared outright: a background reload must not kick you out of the section you're in.
export function resolveScopeAfterLoad(): void {
  if (!scope.stack.length) {
    return;
  }
  const byFile = new Map<string, MindNode>();
  for (const n of state.nodes.values()) {
    if (n.file) {
      byFile.set(n.file, n);
    }
  }
  const next: ScopeLevel[] = [];
  for (const l of scope.stack) {
    const n = l.file ? byFile.get(l.file) : undefined;
    if (!n || !canOpen(n)) {
      break;
    }
    next.push({ rootId: n.id, file: l.file, rect: l.rect, back: null });
  }
  scope.stack = next;
  scope.rootId = next[next.length - 1]?.rootId ?? null;
}

// Truncates at the first level whose section is gone or no longer openable; syncScopeChrome moves the camera.
export function pruneScope(): boolean {
  const cut = scope.stack.findIndex(l => { const n = state.nodes.get(l.rootId); return !n || !canOpen(n); });
  if (cut < 0) {
    return false;
  }
  scope.stack.length = cut;
  scope.rootId = scope.stack[scope.stack.length - 1]?.rootId ?? null;
  scope.pruned = true;
  return true;
}
