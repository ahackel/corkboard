// ============================================================
// OPENING a frame — the scope model.
//
// A frame is "a box with a folder tab on it" (CLAUDE.md), and this is the other half of that
// metaphor: you can OPEN one. While a frame is open the canvas shows nothing but its contents, its
// own box/border/tab are not drawn at all, its interior IS the viewport, and a breadcrumb bar is
// how you come back out. Nesting is allowed, so the crumbs can be several levels deep.
//
// This module is the MODEL only — the ephemeral holder, the predicates, the level stack as data.
// The ACTIONS (open/exit/goToScopeDepth, the camera glides, the repaint) live in main.ts beside
// focusNode, which is their template; the crumb DOM lives in features/breadcrumbs.ts.
//
// Deliberately NOT part of `state` (core/state.ts): `state` is the MAP — every field in it is
// either the notes themselves or something mirrored to disk/localStorage and restored on load. A
// scope is WHERE YOU ARE STANDING. It never reaches frontmatter, it survives a reload only by
// re-resolving file paths, and its camera stack is deliberately session-only. Keeping it here is
// also what makes the `utils/model.ts` → this edge legal: this module imports `core/state.js` and
// (for the one canonical spelling of "is a tab group") `view/layout.js`, never the reverse.
// ============================================================
import { state, type MindNode, type View } from '../core/state.js';
import { isTabsFrame } from '../view/layout.js';

export interface ScopeBack { view: View; sel: string[]; selId: string | null; }
export interface ScopeLevel {
  rootId: string;                                        // the frame open at this level
  file: string | null;                                   // its identity across a reload (see resolveScopeAfterLoad)
  rect: { x: number; y: number; w: number; h: number };   // the frozen viewport rect, world coords
  // What to restore when this level is left. null = a SYNTHESIZED level: one the user never
  // personally stepped through (rebuilt from the URL, or an ancestor of a frame opened straight
  // from the ⋯ menu). Leaving it re-FITS rather than gliding to a camera nobody ever set.
  back: ScopeBack | null;
}

// `rootId` is a denormalized mirror of `stack.at(-1)?.rootId ?? null`. Kept because isHidden reads
// it for every node on every paint, and that path must not pay for an array access + optional chain.
export const scope: { rootId: string | null; stack: ScopeLevel[]; pruned: boolean } =
  { rootId: null, stack: [], pruned: false };

export function scopeActive(): boolean { return scope.rootId !== null; }
export function scopeRootNode(): MindNode | null {
  return scope.rootId ? state.nodes.get(scope.rootId) ?? null : null;
}
export function isScopeRoot(n: MindNode): boolean { return n.id === scope.rootId; }
export function scopeRootFile(): string | null { return scopeRootNode()?.file ?? null; }

// The ONE kind test for "can this be opened", kept kind-agnostic on purpose: widen it HERE, never
// at a call site. Raw `type` rather than isFrame, deliberately — a COLLAPSED frame is openable
// (openFrame unfolds it on the way in) and so is a DOCKED TAB, whose own bounds are only a label in
// the strip but whose CONTENTS are exactly what opening shows.
export function canOpen(n: MindNode | null | undefined): boolean { return n?.type === 'frame'; }

// The scope term of isHidden, on its own — for the few callers that must tell "folded away" from
// "not in the frame I'm standing in" (isSelectable, the cross-scope jumps in main.ts). isHidden
// fuses this with the collapse walk so the paint path only walks the ancestors once.
export function outOfScope(n: MindNode): boolean {
  const id = scope.rootId;
  if (id === null) return false;
  for (let p = n.parent ? state.nodes.get(n.parent) : undefined; p; p = p.parent ? state.nodes.get(p.parent) : undefined)
    if (p.id === id) return false;
  return true;   // never reached the open frame — including when n IS it
}

// The open frame's bounds: a SNAPSHOT of the viewport, taken when the level was pushed (and
// refreshed on a window resize). Read through containerBox/frameInterior, which is what makes the
// contents fill the window instead of a box on the canvas. See refreshScopeRect in main.ts for why
// it's a snapshot at k = 1 and not the live camera.
export function scopeRect(): { x: number; y: number; w: number; h: number } {
  const top = scope.stack[scope.stack.length - 1];
  return top ? top.rect : { x: 0, y: 0, w: 0, h: 0 };
}

// What "no parent" MEANS right now: null at the top level, the OPEN FRAME while one is open. A card
// that gets created — or ripped out of a nested frame — has to land somewhere visible, and while a
// frame is open its interior IS the screen, so a genuine root would simply vanish. The single
// spelling of that, shared by every create/detach path (crud, clipboard, drag, the outline).
export function detachParentId(): string | null { return scope.rootId; }

// The openable ancestors of `t`, outermost first, EXCLUDING t itself — i.e. its folder path.
// A tabs GROUP is skipped: from the user's side it doesn't exist (its open tab stands for it), the
// same reason navArrow's ← steps past it. The crumb path IS this, which is why opening a deep frame
// from the ⋯ menu still shows `Map › A › B › C` rather than `Map › C`.
export function openPathTo(t: MindNode): MindNode[] {
  const out: MindNode[] = [];
  for (let p = t.parent ? state.nodes.get(t.parent) : null; p; p = p.parent ? state.nodes.get(p.parent) : null)
    if (canOpen(p) && !isTabsFrame(p)) out.push(p);
  return out.reverse();
}

// A reload, a map switch or leaving read-only all re-mint every id (data/persistence.ts's
// loadFromDir), so the stack's rootIds go stale. Re-resolve each level by its FILE — the real,
// stable identity — and truncate at the first one that can't be found. On a DIFFERENT map that's
// level 0, so the stack empties with no "did the map change?" test to get wrong; a level whose frame
// was never saved (file null) truncates the same way. The remembered cameras don't survive (their
// selections are stale ids), so leaving re-fits instead of gliding.
// Deliberately NOT cleared outright the way the undo history is: a background refocus reload must not
// kick you out of the frame you're working in.
export function resolveScopeAfterLoad(): void {
  if (!scope.stack.length) return;
  const byFile = new Map<string, MindNode>();
  for (const n of state.nodes.values()) if (n.file) byFile.set(n.file, n);
  const next: ScopeLevel[] = [];
  for (const l of scope.stack) {
    const n = l.file ? byFile.get(l.file) : undefined;
    if (!n || !canOpen(n)) break;
    next.push({ rootId: n.id, file: l.file, rect: l.rect, back: null });
  }
  scope.stack = next;
  scope.rootId = next[next.length - 1]?.rootId ?? null;
}

// Drop any level whose frame is gone (deleted from a query card, undone away, removed on disk) or
// is no longer openable (retyped to a card), truncating the stack at the first casualty. Called
// from applyLayouts — which runs after every structural change — for exactly the reason
// normalizeTabs lives there: ~20 callers, one funnel. Truncation ONLY; the camera recovery belongs
// to syncScopeChrome, since it needs the camera. Returns whether anything was dropped.
export function pruneScope(): boolean {
  const cut = scope.stack.findIndex(l => { const n = state.nodes.get(l.rootId); return !n || !canOpen(n); });
  if (cut < 0) return false;
  scope.stack.length = cut;
  scope.rootId = scope.stack[scope.stack.length - 1]?.rootId ?? null;
  scope.pruned = true;
  return true;
}
