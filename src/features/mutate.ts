// The ONE way a one-shot edit changes the map: one undo step, a reflow, a save ("An edit RUNS
// through mutate"). Gestures spanning pointer events use touch()/commitStep() instead.
import { setStatus } from '../core/state.js';
import { record, touchEdges, touchCanvas } from './history.js';
import { paintAll, relayout, remeasure } from '../render.js';
import { scheduleSave } from '../data/save.js';

// What the edit can have changed, cheapest last; 'none' = the caller repaints itself.
export type Reflow = 'remeasure' | 'relayout' | 'paint' | 'none';

export interface MutateOpts {
  reflow: Reflow;
  status?: string;
  // Set when the edit changes state.edges / state.canvasColor, so the step snapshots it.
  edges?: boolean;
  canvas?: boolean;
}

const REFLOW: Record<Reflow, () => void> = { remeasure, relayout, paint: paintAll, none: () => {} };

// `fn` may touch more nodes. The reflow runs INSIDE the step, so undo/redo restore the settled layout.
export function mutate(ids: Iterable<string | null | undefined>, fn: () => void, opts: MutateOpts): void {
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
}
