// Read-write access to a file or folder handle (File System Access, Chrome/Edge). Neither the permission
// calls nor window.showOpenFilePicker / showDirectoryPicker are in lib.dom.
import type { PickResult } from './types.js';

interface Permable {
  queryPermission(d: { mode: string }): Promise<PermissionState>;
  requestPermission(d: { mode: string }): Promise<PermissionState>;
}
const RW = { mode: 'readwrite' };

// Already granted, so no prompt is needed — what a silent reopen at boot checks.
export async function hasWrite(handle: FileSystemHandle): Promise<boolean> {
  try {
    return (await (handle as unknown as Permable).queryPermission(RW)) === 'granted';
  } catch { return false; }
}

// Granted, or asked for, and the file or folder is really there. Asking needs a fresh click (user
// activation), and a file dropped in from the OS doesn't bring one: Chrome then refuses to ask at all, which
// this reports as 'needs-click'. A REMEMBERED handle can be dead — its folder moved or deleted, or Chrome
// updated and no longer honours handles it stored before — and then asking or reading throws something
// else (an AbortError, a NotFoundError): that is 'gone', so the caller drops it from the recents and says so,
// instead of reporting a permission the user never refused.
export async function ensureWrite(handle: FileSystemHandle): Promise<PickResult> {
  if (!(await hasWrite(handle))) {
    try {
      if ((await (handle as unknown as Permable).requestPermission(RW)) !== 'granted') {
        return 'denied';
      }
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'SecurityError') {
        return 'needs-click';
      }
      return name === 'NotAllowedError' ? 'denied' : 'gone';
    }
  }
  return (await reachable(handle)) ? 'ok' : 'gone';
}

// Can the handle actually be read? Permission alone doesn't say: a stale handle can report 'granted'.
export async function reachable(handle: FileSystemHandle): Promise<boolean> {
  try {
    if (handle.kind === 'file') {
      await (handle as FileSystemFileHandle).getFile();
    } else {
      await (handle as FileSystemDirectoryHandle).entries().next();
    }
    return true;
  } catch {
    return false;
  }
}

// Do two handles name the same file or folder? A remembered handle can be stale — its folder moved,
// deleted, or no longer reachable — and Chrome then REJECTS the comparison (an AbortError) instead of
// answering no. Stale is not the same: one dead entry in the recents must not stop a new one opening.
export async function sameEntry(a: FileSystemHandle, b: FileSystemHandle): Promise<boolean> {
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}
