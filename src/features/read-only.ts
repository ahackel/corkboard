// ---------- read-only mode ----------
// View & collapse only: nothing saves, the sidebar hides, editing icons grey out, and the
// add-child + is hidden. Collapsing is allowed but in-memory only — leaving read-only reloads
// from disk so the saved collapse state is restored.
import { byId } from '../utils/dom.js';
import { state, setStatus } from '../core/state.js';
import { syncFloatBar } from './float-bar.js';
import { scheduleUrlSync } from '../nav/url-state.js';
import { flushSave, store, loadFromDir } from '../data/persistence.js';
import { selectNode } from './selection.js';

const roBadge = byId<HTMLButtonElement>('roBadge');
export function applyReadOnly(): void {
  const ro = state.readOnly;
  document.body.classList.toggle('readonly', ro);
  roBadge.hidden = !ro;
  // ghost card visibility is driven by body.readonly CSS rule
  syncFloatBar();
  setStatus(ro ? 'Read-only — nothing is saved' : 'Editing enabled');
  scheduleUrlSync();
}
export async function setReadOnly(on: boolean): Promise<void> {
  if (on === state.readOnly) return;
  if (on){
    await flushSave();                                   // persist anything pending before locking (clears the save timer)
    state.readOnly = true;
    selectNode(null);                                    // close any open edit
  } else {
    state.readOnly = false;
    if (store.isOpen) await loadFromDir({ keepView:true }); // discard in-memory collapses, restore disk state
  }
  applyReadOnly();
}
roBadge.onclick = () => setReadOnly(false);
