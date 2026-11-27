// The phone INBOX: the top-level section whose folder is `Inbox/` (docs/inbox.md).
import { SECTION_NOTE } from '../utils/filenames.js';
import { type MindNode, state, setStatus } from '../core/state.js';
import { isLockedEffective } from '../utils/model.js';
import { afterReading } from '../data/lazy.js';
import { popScopeFor, exitScope } from '../nav/sections.js';
import { focusNode } from '../nav/focus.js';
import { store } from '../data/active-store.js';
import { scopeActive } from '../nav/scope.js';
import { snapPt, SECTION_W, SECTION_H } from '../view/geometry.js';
import { centredAt, createNode } from './crud.js';
import { worldAtOrCentre } from '../view/camera.js';

const INBOX_NOTE = 'inbox/' + SECTION_NOTE;
const INBOX_GAP = 80;

export const inboxSection = (): MindNode | undefined =>
  [...state.nodes.values()].find(n => n.type === 'section' && n.file?.toLowerCase() === INBOX_NOTE);

// Goes to the Inbox unfolded, or makes one left of all top-level content so it lands on nothing.
export function goToInbox(): void {
  const f = inboxSection();
  if (f) {
    if (f.collapsed && !isLockedEffective(f) && afterReading([f.id], goToInbox, false)) {
      return;
    }
    popScopeFor(f);
    focusNode(f, true);
    return;
  }
  if (!store.isOpen) { setStatus('This map has no Inbox section'); return; }
  while (scopeActive()) {
    exitScope();
  }
  const tops = [...state.nodes.values()].filter(n => !n.parent);
  const left = tops.reduce((x, n) => Math.min(x, n.x), Infinity), top = tops.reduce((y, n) => Math.min(y, n.y), Infinity);
  const at = tops.length ? snapPt({ x: left - SECTION_W - INBOX_GAP, y: top }) : centredAt(worldAtOrCentre());
  const n = createNode({ ...at, type: 'section', w: SECTION_W, h: SECTION_H, title: 'Inbox', parent: null, edit: false });
  if (!n) {
    return;
  }
  focusNode(n);
  setStatus('Made the Inbox — notes saved into its folder show up here (docs/inbox.md)');
}
