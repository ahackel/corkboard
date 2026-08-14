# CLAUDE.md

Guidance for Claude Code in this repository. **Hard rule: this file must never exceed 100 lines** (a
hook rejects writes that would). It is an INDEX: put new rationale in [docs/architecture.md](docs/architecture.md)
and at most a pointer here. If an entry here grows past a couple of lines, move the detail there.

## What this is

**Corkboard** — a local-first visual editor for a folder of Markdown notes. `index.html` (the style +
HTML shell) plus strict-typed ES modules under `src/` (entry `src/main.ts`); Vite +
`vite-plugin-singlefile` bundles it all back into ONE self-contained `dist/index.html`. No runtime
dependencies, no tests, no lint.

## Running / developing

- `npm install` once, then `npm run dev` (localhost:5173). OPFS needs https/localhost — not `file://`.
- `npm run build` → `dist/index.html` + `dist/help/`; `npm run preview` serves it. Push to `main`
  deploys to GitHub Pages (`.github/workflows/deploy.yml`).
- `npm run typecheck` (`tsc --noEmit`) after touching types. Fully strict, no `@ts-nocheck` — keep it
  that way. Keep `.js` in import specifiers (bundler resolution maps them to `.ts`).
- Verify changes by running the app in a browser and exercising the canvas.
- Help content is `public/help/*.md`, embedded at build time (`import.meta.glob '?raw'` in `boot.ts`)
  rather than fetched, so it works from `file://` too.
- Runs in any modern browser incl. iPad (OPFS default); "Open folder" needs FSA (Chrome/Edge only).

## Module layout (`src/`)

- `core/state.ts` — the mutable `state` (the MAP: nodes, view, selection, flags) + types + DOM handles.
- `core/ui-state.ts` — the mutable `ui` holder for live interaction state (drag/edit/pan/marquee/
  pinch). Mutate in place, never reassign, so every module shares one interaction state.
- `utils/` — pure helpers: `markdown.ts`, `frontmatter.ts` (`parseMd`/`serializeMd`), `model.ts`
  (derived-tree queries: `parentOf`/`ancestors`/`isHidden`/`nodeLabel`), `ink.ts`, `zip.ts`, `idb.ts`,
  `dom.ts`, `num.ts`.
- `store/` — the swappable I/O boundary, one concern per file: `opfs.ts` (default), `fsa.ts`,
  `idb-store.ts`, `handle-store.ts`, `recents.ts`, `watch.ts`, `types.ts`, `index.ts`.
- `data/persistence.ts` — disk orchestration: the active `store` + `useStore`, debounced autosave
  (`scheduleSave`/`flushSave`), `loadFromDir`, `reloadFromDisk`, zip import/export. Renders no UI.
- `view/` — `camera.ts`, `layout.ts` (all placement, container predicates, the stack outliner),
  `edges.ts`, `theme.ts`, `grid.ts`, `icons.ts`.
- `nav/` — where you ARE rather than what the map is: `url-state.ts` (the hash), `scope.ts` (the
  open-frame model).
- `features/` — the interactive subsystems, sharing state via `ui`: drag, gestures, inline-edit, crud,
  text-drag, attachments, clipboard, search, outline, float-bar, properties, breadcrumbs, history, …
- `boot.ts` — local-first boot onto the last map, the home/storage screen, the help store.
- `main.ts` — entry: the render core (`paintNode`/`paintAll`/`effectiveColor`), selection, read-only
  mode, global keyboard/toolbar wiring. Its `main`↔feature cycles are deliberate and runtime-only.

## Non-negotiable invariants

Each has a longer "why" in `docs/architecture.md`; read it before changing the code it governs.

- **One `.md` file per node, and the file's PATH is its identity** (`mm_parent` points at it, the hash
  encodes it). No database, no sidecar. In-memory `id`s are ephemeral — never persist them.
- **A node's TITLE is the leading `# ` line of its body and nothing else** (`splitHeading`/
  `joinHeading`, exact inverses). Not frontmatter, not the filename. No heading means an UNTITLED
  card. The filename is a derived slug, minted ONCE and never re-derived; titles may collide.
- **Where a name is SHOWN rather than edited, use `nodeLabel`** (title → first line → filename stem →
  "Untitled"); `disambiguatedLabel` for flat lists only.
- **Edges are derived, never stored** — the whole tree is computed from `mm_parent`.
- **Layout lives in `mm_*` frontmatter** (`mm_parent`, `mm_position_x`/`_y`, `mm_side`,
  `mm_collapsed`, `mm_type`, `mm_layout`, `mm_w`/`mm_h`, `mm_locked`, `mm_done`, `mm_checklist`,
  `mm_query`). `serializeMd` rewrites ONLY app-owned keys (`tags`, `color`, `mm_*`) and preserves
  every other field and the body verbatim. `mm_*` is the file format — never rename it.
- **KIND (`mm_type`) and child ARRANGEMENT (`mm_layout`) are two axes**, resolved by `foldTypeLayout`
  (which also folds legacy spellings, `image` → `card`). Kinds: card, frame, stack, annotation, query.
- **`n.w` is always AUTHORED; `n.h` only for frame/query and an IMAGE card** — a card whose note is
  one `![](…)` and nothing else: no padding, aspect-locked resize, a 40px icon when folded.
  Derived from the text (`isImageCard`), never a kind. Card/annotation/stack measure their height.
- **Visibility has ONE gate, `isHidden`, with two terms**: a collapsed ancestor (persisted) and the
  open-frame scope (ephemeral). Add new terms IN it, never beside it. Nothing writes through it.
- **Every mutation calls `scheduleSave()`**; `state.readOnly` and `store.isOpen === false` (demo mode)
  make writes no-ops. Collapsing and opening a frame stay allowed in read-only — they mutate nothing.
- **Mutation paths end in `relayout()` or `remeasure()`** (`main.ts`), never a hand-written
  `applyLayouts(); paintAll();`. Use `remeasure` whenever a card's own measured height can change: the
  layout pass reads `offsetHeight`, so it needs current DOM (the paint-before-measure rule).
- **Anything writing a node's `left`/`top` goes through `placeSelf` + `elTop`**, never bare `place()`.
- **A colour is a palette key OR an authored `#rrggbb`**, and nothing branches on which: go through
  `colorFill` / `colorClass` / `applyColorVars`, never build `c-${color}` by hand. Ink and scrim are
  DERIVED from the fill (`utils/ink.ts`), never authored, and no CSS rule may name a colour key to fix
  its text. A custom hex is written quoted on disk (a bare `#rrggbb` is a YAML comment).
- **Markdown rendering is a small hand-rolled subset** (`renderBodyHTML`) — extend it rather than
  reaching for a library; the no-dependency single-file constraint is deliberate.
- **The product is "Corkboard"; the document is a "map"/"board".** The old `mindmap` name survives
  only in `utils/legacy-keys.ts`, `openRenamed` (`utils/idb.ts`) and the `mm_*` keys.

## Deep dives (`docs/architecture.md`) — look each up by its **bolded lead sentence**

- Frames — "A `frame`'s BOUNDS include its title tab" · "A container's two side wrappers are
  LIFECYCLE-managed" · "A frame with `mm_layout: tabs` is a TAB GROUP" · "A frame can be OPENED, and
  then the canvas IS its interior" (scope, crumbs, canvas colour, `detachParentId`).
- Stacks — "A `stack` is an OUTLINER"; files — "A body-less note is MIGRATED on load" · "A card whose
  whole note is one image IS that image".
- Interaction — "Collapse has FOUR entry points" (the `.hidden-count` chip) · "Double-click /
  double-tap OPENS a node" · "Arrow keys go IN and OUT" · "MERGING notes and BREAKING them apart are
  two DRAGS" · "`⌘A` selects everything ON THE CANVAS" · "Touch input".
- Storage — "The `store` adapter is the single swappable I/O boundary" (three adapters: OPFS, IndexedDB
  fallback, FSA) · "Boot order" · "Help map" · "External-change reload".
- Colour and zoom — "ONE card palette for both themes" · "A card's text colour is DERIVED from its
  fill" · "Recently-used custom colours" · "Below `FAR_ZOOM`".
