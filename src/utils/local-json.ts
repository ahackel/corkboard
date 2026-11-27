// Tolerates absent or corrupt entries and a missing localStorage.
export function readJSON<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

export function writeJSON(key: string, val: unknown): void { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// Drops anything but strings a corrupt entry holds.
export function readStrings(key: string): string[] {
  const v = readJSON<unknown>(key, []);
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

// Moves `item` to the front (dropping its older copy, compared by `same`), keeping at most `max`.
export function pushRecent(key: string, item: string, max: number, same: (s: string) => string = s => s): void {
  writeJSON(key, [item, ...readStrings(key).filter(s => same(s) !== same(item))].slice(0, max));
}
