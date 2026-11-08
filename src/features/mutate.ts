// ---------- the ONE way a one-shot edit changes the map ----------
// Every non-gesture mutation goes through mutate(), which owns the rules each call site used to repeat
// by hand (CLAUDE.md, "Non-negotiable invariants"): read-only refuses it, the change is ONE undo step,
// it ends in relayout()/remeasure() (or a plain paint), and it calls scheduleSave(). Gestures that span
// pointer events (drag, resize, inline edit, line drawing) still open a step with touch() and close it
// with commitStep() at their own boundary — a step there lasts longer than one function call.
import { state, setStatus } from '../core/state.js';
import { record, touchEdges, touchCanvas } from './history.js';
import { paintAll, relayout, remeasure } from '../main.js';
import { scheduleSave } from '../data/save.js';

// What the edit can have changed, cheapest last: a card's measured height (remeasure), positions or
// containment (relayout), only looks (paint), or nothing the caller doesn't repaint itself (none).
export type Reflow = 'remeasure' | 'relayout' | 'paint' | 'none';

export interface MutateOpts {
  reflow: Reflow;
  status?: string;
  edges?: boolean;      // the edit changes state.edges: snapshot the edge list into the step
  canvas?: boolean;     // the edit changes state.canvasColor: snapshot it into the step
}

const REFLOW: Record<Reflow, () => void> = { remeasure, relayout, paint: paintAll, none: () => {} };

// Run `fn` as one undoable edit of the nodes `ids` (touch more inside `fn` as it finds them). The
// reflow runs INSIDE the step, so whatever layout settles on is what undo and redo restore. Returns
// false, having changed nothing, when the map is read-only.
export function mutate(ids: Iterable<string | null | undefined>, fn: () => void, opts: MutateOpts): boolean {
  if (state.readOnly) {
    return false;
  }
  record(ids, () => {
    if (opts.edges) {
      touchEdges();
    }
    if (opts.canvas) {
      touchCanvas();
    }
    fn();
    REFLOW[opts.reflow]();
  });
  scheduleSave();
  if (opts.status) {
    setStatus(opts.status);
  }
  return true;
}
