// `data-saving` on <html> while a write is queued or in flight, so the e2e specs can wait for the disk.
const busy = new Set<'notes' | 'board'>();

export function setSaving(what: 'notes' | 'board', on: boolean): void {
  if (on) {
    busy.add(what);
  } else {
    busy.delete(what);
  }
  document.documentElement.toggleAttribute('data-saving', busy.size > 0);
}
