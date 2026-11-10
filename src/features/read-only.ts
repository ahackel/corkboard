// ---------- read-only mode ----------
// View & collapse only: nothing saves, the sidebar hides, editing icons grey out, and the
// add-child + is hidden. Collapsing is allowed but in-memory only — leaving read-only reloads
// from disk so the saved collapse state is restored.
import { byId } from '../utils/dom.js';
import { state, setStatus } from '../core/state.js';
import { syncFloatBar } from './float-bar.js';
import { scheduleUrlSync } from '../nav/url-state.js';
import { store } from '../data/persistence.js';
import { selectNode } from './selection.js';
import { settleSave } from '../data/save.js';
import { loadFromDir } from '../data/load.js';

const roBadge = byId<HTMLButtonElement>('roBadge');

// Brings the page in line with `state.readOnly`. Only a CHANGE is announced: boot calls this too, and a
// fresh board saying "Read-only is off" would narrate a mode nobody turned on.
export function applyReadOnly({ announce = false }: { announce?: boolean } = {}): void {
  const ro = state.readOnly;
  document.body.classList.toggle('readonly', ro);
  roBadge.hidden = !ro;
  // ghost card visibility is driven by body.readonly CSS rule
  syncFloatBar();
  if (announce) {
    setStatus(ro ? 'Read-only is on. Nothing is saved.' : 'Read-only is off');
  }
  scheduleUrlSync();
}

export async function setReadOnly(on: boolean): Promise<void> {
  if (on === state.readOnly) {
    return;
  }
  if (on){
    await settleSave();                                  // persist anything pending (notes AND board.json) before locking
    state.readOnly = true;
    selectNode(null);                                    // close any open edit
  } else {
    state.readOnly = false;
    if (store.isOpen) {
      await loadFromDir({ keepView:true }); // discard in-memory collapses, restore disk state
    }
  }
  applyReadOnly({ announce: true });
}
roBadge.onclick = () => setReadOnly(false);
