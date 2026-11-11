// Ask the browser to KEEP what is stored on this device. Without it the notes sit in "best effort"
// storage, which a browser may clear when the disk runs low. Asked once, on the first write: by then
// there is something worth keeping. A refusal changes nothing — the store works as before.
let asked = false;

export function keepStorage(): void {
  if (asked) {
    return;
  }
  asked = true;
  void navigator.storage?.persist?.().catch(() => false);
}
