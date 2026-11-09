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

// Granted, or asked for. Asking needs a fresh click (user activation), and a file dropped in from the OS
// doesn't bring one: Chrome then refuses to ask at all, which this reports as 'needs-click'.
export async function ensureWrite(handle: FileSystemHandle): Promise<PickResult> {
  if (await hasWrite(handle)) {
    return 'ok';
  }
  try {
    return (await (handle as unknown as Permable).requestPermission(RW)) === 'granted' ? 'ok' : 'denied';
  } catch (e) {
    return (e as DOMException).name === 'SecurityError' ? 'needs-click' : 'denied';
  }
}
