// The contract every storage backend implements — the single swappable I/O boundary.
// opfsStore / fsaStore / idbStore all satisfy this; main.js holds the active `store`.

// A note read from / written to disk: relative '/'-separated path + its text.
export interface NoteFile { path: string; text: string; }

import type { FoldTest, LazyFolder } from './tree.js';
export interface TreeListing { files: NoteFile[]; lazy: Map<string, LazyFolder>; foreign: Set<string>; }

// Outcome of an open attempt. Different backends use different subsets.
export type PickResult = 'ok' | 'cancel' | 'denied' | 'unsupported' | 'error' | 'gone';

export interface Store {
  readonly isOpen: boolean;
  readonly name: string;
  pick(): Promise<PickResult>;
  // The notes under the folder `under` ('' = all), leaving unread every folder `fold` says is folded
  // (store/tree.ts) — what the load and the unfold of a section read through.
  listTree(under: string, fold: FoldTest): Promise<TreeListing>;
  removeDir(dir: string): Promise<void>;     // only if empty
  write(path: string, data: string | Blob): Promise<void>;
  remove(path: string): Promise<void>;
  readBlob(path: string): Promise<Blob | null>;
  watch(cb: () => void): void;
}

// On-device backends (OPFS / the IndexedDB fallback) additionally host MULTIPLE maps and
// manage their disk lifecycle. FSA folders are one map each, chosen by the user, so the
// plain Store contract has none of this.
export interface DeviceStore extends Store {
  openMap(id: string, name?: string): void;
  createMap(id: string, name: string): Promise<void>;
  deleteMap(id: string): Promise<void>;
  renameMap(id: string, name: string): Promise<void>;
  listMaps(): Promise<Array<{ id: string; name: string }>>;
}
