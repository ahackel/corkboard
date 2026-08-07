// ============================================================
// One-time rename migration (mindmap → Corkboard) for localStorage.
// Everything the app persists OUTSIDE the vault used to be prefixed `mindmap.` — the theme,
// the edge style, the map registry, the MRU lists. A localStorage key can't be renamed in
// place, so each is copied to its `corkboard.` twin once and the old one dropped.
// What is deliberately NOT renamed: the notes' `mm_*` frontmatter keys. Those are the FILE
// FORMAT — a vault has to keep opening in Obsidian and in any older build — not the product
// name. The IndexedDB half of the same rename lives in utils/idb.ts (`openRenamed`).
//
// Runs on IMPORT, and main.ts imports this module FIRST. Every setting is read from inside
// a function, but only import order can guarantee we get there before the first of them —
// initEdgeStyle() and setupTheme() both run while main.ts's own body evaluates.
// ============================================================
const LEGACY_PREFIX = 'mindmap.', PREFIX = 'corkboard.';

try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const val = localStorage.getItem(key);
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    // Never clobber a value the renamed build already wrote (an upgrade/downgrade round-trip).
    if (val !== null && localStorage.getItem(next) === null) localStorage.setItem(next, val);
    localStorage.removeItem(key);
  }
} catch {}

export {};
