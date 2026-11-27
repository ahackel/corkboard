// What data/ asks of the UI above it, since data/ never imports the UI. main.ts fills these in before boot;
// until then each does nothing, which is all a test of data/ alone needs.
import { type MindNode } from '../core/state.js';

export interface DataHooks {
  paintNode(n: MindNode): void;
  remeasure(): void;

  forgetHistory(): void;

  // The ids the undo history still refers to: a folded section keeps notes these name in memory.
  historyRefs(): Set<string>;

  // A search keeps every folded section read.
  searchHolds(): boolean;

  showMapName(): void;

  leaveHome(): void;

  // Puts the selection back and points out what came in from outside.
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
