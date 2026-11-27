// Read-write access to an FSA handle. The permission calls aren't in lib.dom.
import type { PickResult } from './types.js';

interface Permable {
  queryPermission(d: { mode: string }): Promise<PermissionState>;
  requestPermission(d: { mode: string }): Promise<PermissionState>;
}
const RW = { mode: 'readwrite' };

// Already granted, no prompt: what a silent reopen at boot checks.
export async function hasWrite(handle: FileSystemHandle): Promise<boolean> {
  try {
    return (await (handle as unknown as Permable).queryPermission(RW)) === 'granted';
  } catch { return false; }
}

// Asking needs a fresh click, which an OS drop doesn't bring ('needs-click'). A remembered handle can be
// dead (folder moved, or Chrome no longer honours it): asking then throws something else, reported 'gone'.
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

// A stale handle can still report 'granted'.
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

// Chrome REJECTS comparing a stale handle instead of answering no; one dead recent must not block a new one.
export async function sameEntry(a: FileSystemHandle, b: FileSystemHandle): Promise<boolean> {
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
}
