// One-time localStorage rename `mindmap.` → `corkboard.`; main.ts runs it before anything reads a setting.
// The `mm_*` frontmatter keys are the FILE FORMAT and are never renamed.
const LEGACY_PREFIX = 'mindmap.', PREFIX = 'corkboard.';

export function migrateLegacyKeys(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(LEGACY_PREFIX)) {
        continue;
      }
      const val = localStorage.getItem(key);
      const next = PREFIX + key.slice(LEGACY_PREFIX.length);

      // Never clobber a value the renamed build already wrote.
      if (val !== null && localStorage.getItem(next) === null) {
        localStorage.setItem(next, val);
      }
      localStorage.removeItem(key);
    }
  } catch {}
}
