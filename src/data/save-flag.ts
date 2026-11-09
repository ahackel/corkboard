// Is a write queued or in flight? Mirrored as `data-saving` on <html>, so the e2e specs can wait for
// the disk to catch up instead of guessing how long the debounced autosave takes. Notes and the board
// save on their own timers, so each reports its own half.
const busy = new Set<'notes' | 'board'>();

export function setSaving(what: 'notes' | 'board', on: boolean): void {
  if (on) {
    busy.add(what);
  } else {
    busy.delete(what);
  }
  document.documentElement.toggleAttribute('data-saving', busy.size > 0);
}
