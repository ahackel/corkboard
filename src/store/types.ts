// The contract every storage backend implements.

export interface NoteFile { path: string; text: string; }

import type { FoldTest, LazyFolder } from './tree.js';
export interface TreeListing { files: NoteFile[]; lazy: Map<string, LazyFolder>; foreign: Set<string>; assets?: string[]; }

export type PickResult = 'ok' | 'cancel' | 'denied' | 'unsupported' | 'error' | 'gone' | 'needs-click';

export interface Store {
  readonly isOpen: boolean;
  readonly name: string;
  readonly singleNote?: boolean;
  pick(): Promise<PickResult>;
  // '' = the whole map. Folders `fold` answers yes for are left unread.
  listTree(under: string, fold: FoldTest): Promise<TreeListing>;
  removeDir(dir: string): Promise<void>;     // only if empty
  write(path: string, data: string | Blob): Promise<void>;
  remove(path: string): Promise<void>;
  readBlob(path: string): Promise<Blob | null>;
  watch(cb: () => void): void;
  // False when nothing outside the app touched the files; unknown counts as changed.
  changed?(): Promise<boolean>;
}

// On-device backends host many maps; an FSA folder is one map.
export interface DeviceStore extends Store {
  openMap(id: string, name?: string): void;
  createMap(id: string, name: string): Promise<void>;
  deleteMap(id: string): Promise<void>;
  renameMap(id: string, name: string): Promise<void>;
  listMaps(): Promise<Array<{ id: string; name: string }>>;
}
