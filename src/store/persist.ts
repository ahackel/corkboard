// Asks once, on the first write, for persistent storage: "best effort" may be cleared when the disk runs low.
let asked = false;

export function keepStorage(): void {
  if (asked) {
    return;
  }
  asked = true;
  void navigator.storage?.persist?.().catch(() => false);
}
