// ============================================================
// What the data layer asks of the UI above it. data/ reads and writes notes; painting them, the undo
// history, the search, the selection and the crumbs are features/ and main.ts, which import data/ —
// so data/ never imports them back. It calls these instead, and main.ts fills them in before boot()
// (installDataHooks). Until then each does nothing, which is all a test of data/ alone needs.
// ============================================================
import { type MindNode } from '../core/state.js';

export interface DataHooks {
  paintNode(n: MindNode): void;
  remeasure(): void;

  // A (re)load is about to mint every id afresh, so nothing in the undo history can survive it.
  forgetHistory(): void;

  // The ids the undo history still refers to: a folded section keeps notes these name in memory.
  historyRefs(): Set<string>;

  // A search is up: it reads every folded section and keeps them read (data/lazy.ts).
  searchHolds(): boolean;

  // The open map's name changed or was set: show it in the crumbs and the tab title.
  showMapName(): void;

  // A map is about to open over the home screen: put that away.
  leaveHome(): void;

  // A reload from disk finished: put the selection back and point out what came in from outside.
  reloaded(selId: string | null, arrived: string[]): void;
}

export const dataHooks: DataHooks = {
  paintNode: () => {},
  remeasure: () => {},
  forgetHistory: () => {},
  historyRefs: () => new Set(),
  searchHolds: () => false,
  showMapName: () => {},
  leaveHome: () => {},
  reloaded: () => {},
};

export function installDataHooks(hooks: DataHooks): void {
  Object.assign(dataHooks, hooks);
}
