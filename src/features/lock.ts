import { nodesOf, isLockedEffective } from '../utils/model.js';
import { state } from '../core/state.js';
import { mutate } from './mutate.js';
import { syncFloatBar } from './float-bar.js';

// A mixed selection counts as locked, so the toggle unlocks all — the L key and the float bar's
// lock button (the only way out of a locked selection) must agree on that.
export function anyLocked(ids: Iterable<string>): boolean {
  return nodesOf(ids).some(isLockedEffective);
}

export function toggleLockSelection(): void {
  setLockedSelection(state.sel, !anyLocked(state.sel));
}

export function setLockedSelection(ids: Iterable<string>, locked: boolean): void {
  const cards = nodesOf(ids).filter(n => n.locked !== locked);
  if (!cards.length) {
    return;
  }
  mutate(cards.map(n => n.id), () => { for (const n of cards){ n.locked = locked; n.dirty = true; } },
    { reflow: 'paint', status: `${locked ? 'Locked' : 'Unlocked'} ${cards.length} card${cards.length===1?'':'s'}` });
  syncFloatBar();
}
