// The desktop app's calls into its native side (src-tauri/src/files.rs), through the global Tauri injects
// into the window (`withGlobalTauri`): no npm package, so no runtime dependency. Only the desktop build
// (DESKTOP_BUILD) ever calls these; in a browser `__TAURI__` is absent and nothing here runs.

interface TauriGlobal {
  core: { invoke<T>(cmd: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<T> };
  event: { listen(event: string, handler: () => void): Promise<() => void> };
}

// A file in a listing, and the size + modification time any write hands back.
export interface FileEntry { path: string; size: number; mtime: number; }
export interface FileStamp { size: number; mtime: number; }

function tauri(): TauriGlobal {
  const t = (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!t) {
    throw new Error('Not running in the Corkboard desktop app');
  }
  return t;
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().core.invoke<T>(cmd, args);
}

export const native = {
  list: (root: string, under: string) => invoke<FileEntry[]>('list_files', { root, under }),
  readTexts: (root: string, paths: string[]) => invoke<string[]>('read_texts', { root, paths }),
  readBytes: (root: string, path: string) => invoke<ArrayBuffer>('read_bytes', { root, path }),
  writeText: (root: string, path: string, text: string) => invoke<FileStamp>('write_text', { root, path, text }),

  // A picture's bytes go as the call's raw body; header values must be ASCII, hence the encoding.
  writeBytes: (root: string, path: string, bytes: Uint8Array) => tauri().core.invoke<FileStamp>('write_bytes', bytes, {
    headers: { 'x-root': encodeURIComponent(root), 'x-path': encodeURIComponent(path) },
  }),
  remove: (root: string, path: string) => invoke<void>('remove_file', { root, path }),
  removeEmptyDir: (root: string, path: string) => invoke<void>('remove_empty_dir', { root, path }),
  kindOf: (path: string) => invoke<'dir' | 'file' | null>('kind_of', { path }),
  stat: (path: string) => invoke<FileStamp>('stat', { path }),
  readTextAt: (path: string) => invoke<string>('read_text_at', { path }),
  writeTextAt: (path: string, text: string) => invoke<FileStamp>('write_text_at', { path, text }),
  pickFolder: (near?: string) => invoke<string | null>('pick_folder', { near: near ?? null }),
  pickNote: (near?: string) => invoke<string | null>('pick_note', { near: near ?? null }),
  reveal: (path: string) => invoke<void>('reveal', { path }),
  takeOpened: () => invoke<string[]>('take_opened_paths'),
  onOpened: (handler: () => void) => tauri().event.listen('opened', handler),
};

export function stampText(s: FileStamp): string { return s.size + ':' + s.mtime; }

export function baseName(path: string): string { return path.replace(/\/+$/, '').split('/').pop() ?? path; }

// A desktop map's registry key IS its path (store/maps.ts MapRef.id): there is no handle to keep, and a
// folder that moved is simply not there any more.
const KEY_PREFIX = 'path:';
export const keyOfPath = (path: string): string => KEY_PREFIX + path;
export const pathOfKey = (key: string | undefined): string | null => key?.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null;
