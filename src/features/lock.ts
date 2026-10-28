// ---------- locking cards in place ----------
import { nodesOf, isLockedEffective } from '../utils/model.js';
import { state, setStatus } from '../core/state.js';
import { record } from './history.js';
import { paintAll } from '../main.js';
import { syncFloatBar } from './float-bar.js';
import { scheduleSave } from '../data/persistence.js';

// Lock/unlock every selected card (the float bar's lock toggle / L). Locking freezes that card in place — no move,
// (un)collapse, rename/body/color/type/layout edit, add-child, or delete — and cascades so its
// whole subtree becomes unselectable too (see utils/model.ts). Unlocking never touches descendants
// (lock is per-card, not stored on them). A descendant of a locked ancestor can't be selected, so
// it never reaches this function as a target; only cards actually selectable can be (un)locked.
// Does a selection count as LOCKED for toggle purposes? A mixed selection does, so the toggle
// unlocks all. Lives next to the mutator because both the L shortcut and the float bar's lock
// button need it, and the two must never disagree on the mixed-selection rule — that button is the
// only escape hatch out of a locked selection.
export function anyLocked(ids: Iterable<string>): boolean {
  return nodesOf(ids).some(isLockedEffective);
}

export function toggleLockSelection(): void {
  setLockedSelection(state.sel, !anyLocked(state.sel));
}

export function setLockedSelection(ids: Iterable<string>, locked: boolean): void {
  if (state.readOnly) {
    return;
  }
  const cards = nodesOf(ids).filter(n => n.locked !== locked);
  if (!cards.length) {
    return;
  }
  record(cards.map(n => n.id), () => { for (const n of cards){ n.locked = locked; n.dirty = true; } });
  paintAll();
  syncFloatBar();   // the bar collapses to just its lock toggle while the selection is locked
  scheduleSave();
  setStatus(`${locked ? 'Locked' : 'Unlocked'} ${cards.length} card${cards.length===1?'':'s'}`);
}
