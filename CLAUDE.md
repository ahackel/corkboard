# CLAUDE.md

Guidance for Claude Code in this repository. **Hard rule: this file must never exceed 100 lines** (a
hook rejects writes that would). It is an INDEX: put new rationale in [docs/architecture.md](docs/architecture.md)
and at most a pointer here. If an entry here grows past a couple of lines, move the detail there.

## What this is

**Corkboard** — a playful sticky-note wall for sorting thoughts by hand, over a folder of Markdown notes.
**Check every feature against [docs/PRODUCT.md](docs/PRODUCT.md)** (the north star, incl. the CUT list).
`index.html` (style + HTML shell) plus strict-typed ES modules under `src/` (entry `src/main.ts`); Vite +
`vite-plugin-singlefile` bundles it all into ONE self-contained `dist/index.html`. No runtime deps.
`npm run lint` (ESLint, `eslint.config.js`) must pass; `npm test` (vitest) pins the FILE FORMAT — run it after;
`npm run e2e` (Playwright, `e2e/`) drives the canvas in Chromium — run it after touching interactions.

## Running / developing

- `npm install` once, then `npm run dev` (localhost:5173). OPFS needs https/localhost — not `file://`.
- `npm run build` → `dist/index.html`; `npm run preview` serves it; a push to `main` deploys it (`deploy.yml`).
- `npm run typecheck` after touching types (fully strict, no `@ts-nocheck`); verify in a browser by exercising
  the canvas. Keep `.js` in import specifiers (bundler resolution maps them to `.ts`).
- **Code style** (all code you write or touch): readable code over comments — comment only what it can't say;
  a blank line before every comment and function/class definition; braces on every `if`/`else`/loop body.
- Runs in any modern browser incl. iPad (OPFS default); "Open folder" needs FSA (Chrome/Edge only).

## Module layout (`src/`)

- `core/state.ts` — the mutable `state` (the MAP: nodes, view, selection, flags) + types + DOM handles.
- `core/ui-state.ts` — the mutable `ui` holder for live interaction state (drag/edit/pan/marquee/
  pinch). Mutate in place, never reassign, so every module shares one interaction state.
- `utils/` — pure helpers: `markdown.ts`, `md-edit.ts` (editor keys: list/table Enter, Tab, ⌘B/I/L, ⌥↑↓), `frontmatter.ts` (`parseMd`/`serializeMd`), `model.ts`
  (`parentOf`/`ancestors`/`isHidden`/`nodeLabel`), `filenames.ts` (slug/rename/link fixup), `tags.ts` (Obsidian tags), `paste-list.ts`, `guides.ts` (smart-guide geometry), `ink.ts`, `zip.ts`, `idb.ts`, `dom.ts`, `num.ts`.
- `store/` — the swappable I/O boundary, one concern per file: `opfs.ts` (default), `fsa.ts`,
  `idb-store.ts`, `handle-store.ts`, `tree.ts` (what a load reads), `recents.ts`, `maps.ts`, `watch.ts`, `types.ts`, `index.ts`.
- `data/` — `persistence.ts` (the active `store`, `useStore`, switching maps), `load.ts` (`loadFromDir`/`readFolder`), `save.ts`
  (debounced `scheduleSave`/`flushSave`), `migrate.ts`, `zip-io.ts`, `board.ts` (the ONE sidecar), `lazy.ts` (folded sections), `save-alert.ts`.
- `view/` — `camera.ts`, `layout.ts` (section geometry, the drop test `sectionAt`, `holderOf`), `geometry.ts` (`nodeW`/`nodeH`, sizes,
  grid snap), `color.ts` (palette, `colorFill`), `free-edges.ts`, `grid.ts`, `icons.ts`.
- `nav/` — where you ARE: `url-state.ts` (the hash), `scope.ts` (open sections), `sections.ts` (opening/leaving), `focus.ts`.
- `features/` — the interactive subsystems, sharing state via `ui`: drag, gestures, inline-edit, crud, selection, fold,
  resize, text-drag, attachments, clipboard, search, guides, float-bar, properties, breadcrumbs, history, …
  `commands.ts` holds every keyboard shortcut and `paletteCommands`, ⌘P's ONLY list of every action — add new ones there.
- `boot.ts` — local-first boot onto the last map, the home/storage screen.
- `main.ts` — entry + render core (`paintNode`/`paintAll`/`placeSelf`/`effectiveColor`); its `main`↔feature cycles are runtime-only.

## Non-negotiable invariants

Each has a longer "why" in `docs/architecture.md`; read it before changing the code it governs.

- **One `.md` file per node, and the file's PATH is its identity**; ONE `board.json` holds ARRANGEMENT, never content.
- **A section IS a folder** (`Name/_index.md` + its cards; parent = the path, `parentFileOf`); a move moves the file
  (`planPaths`). A FOLDED section's folder is NOT READ until needed and lets go once saved (`data/lazy.ts`).
- **A node's TITLE is the leading `# ` line of its body and nothing else** (`splitHeading`/
  `joinHeading`, exact inverses). Not frontmatter, not the filename; no heading = an UNTITLED card. The
  filename is a slug TRACKING that text: re-derived each save, renamed on edit-commit, suffixed `Notes 2.md`.
- **Where a name is SHOWN, use `nodeLabel`** (title → first line → `No-title N`, never the filename
  stem); `disambiguatedLabel` for flat lists only. An emptied note says so: `mm_blank`.
- **Hierarchy is CONTAINMENT; every LINE is a drawn edge** — a card sits in the section that is its parent;
  free edges live in `board.json`, ELBOW card to card (route derived, never stored), and mean nothing structural.
- **Layout lives in `mm_*` frontmatter** (`mm_position_x`/`_y`,
  `mm_collapsed`, `mm_type`, `mm_w`/`mm_h`, `mm_locked`, `mm_blank`; cut keys are dropped on write). `serializeMd` rewrites ONLY app-owned keys (`tags`, `color`, `mm_*`) and preserves
  every other field and the body verbatim. `mm_*` is the file format — never rename it.
- **Two kinds, card and section (`mm_type`, `foldType`); CARDS NEVER HOLD CARDS.** Every create/paste goes
  through `holderOf`; a drop lands in the innermost section under the card's centre (`sectionAt`), else the top level.
- **`n.w`/`n.h` are AUTHORED; a plain card's `n.h` is a MIN-height its text can exceed** (dragged shorter, `n.clip`: exact, clipped). An IMAGE card is a card whose note is
  one `![](…)` and nothing else: no padding, aspect-locked resize, a 40px icon when folded.
  Derived from the text (`isImageCard`), never a kind. A card measures its height.
- **Visibility has ONE gate, `isHidden`**: a FOLDED section ancestor (persisted), the open-section scope
  (ephemeral) and a STACK not fanned out. Add new terms IN it, never beside it. Nothing writes through it.
- **Every mutation calls `scheduleSave()`** (flushed on tab-hide; a failure shows a banner and retries); `state.readOnly` and `store.isOpen === false` (demo mode)
  make writes no-ops. Folding a card and opening a section stay allowed in read-only — they mutate nothing.
- **Mutation paths end in `relayout()` or `remeasure()`** (`main.ts`), never a hand-written
  `applyLayouts(); paintAll();`. Use `remeasure` whenever a card's own measured height can change: the
  layout pass reads `offsetHeight`, so it needs current DOM (the paint-before-measure rule).
- **Anything writing a node's `left`/`top` goes through `placeSelf`**, never bare `place()`.
- **A colour is a palette key OR an authored `#rrggbb`**, and nothing branches on which: go through
  `colorFill` / `colorClass` / `applyColorVars`, never build `c-${color}` by hand. Ink and scrim are
  DERIVED from the fill (`utils/ink.ts`), never authored, and no CSS rule may name a colour key to fix
  its text. A custom hex is written quoted on disk (a bare `#rrggbb` is a YAML comment).
- **Markdown rendering is a small hand-rolled subset** (`renderBodyHTML`) — extend it rather than
  reaching for a library; the no-dependency single-file constraint is deliberate.
- **The product is "Corkboard"; the document is a "map"/"board".** The old `mindmap` name survives
  only in `utils/legacy-keys.ts`, `openRenamed` (`utils/idb.ts`) and the `mm_*` keys.

## Deep dives (`docs/architecture.md`) — look each up by its **bolded lead sentence**

- Sections — "A section COLLECTS what it covers" · "A section's BOUNDS are its box" · "A container's content wrapper is
  LIFECYCLE-managed" · "A section can be OPENED, and then the canvas IS its interior" · "A CARD is never opened"
  (scope, crumbs, canvas colour, `detachParentId`) · "A STACK is a section drawn as a PILE" (`isStack`, the fan).
- The model — "Cards are flat; a SECTION is the only container" (drop rule, grow-to-hold, load migration) · "A section's
  note is drawn on its LABEL"; files — "A body-less note is MIGRATED on load" · "A note that is blank ON PURPOSE
  says so" · "A card whose whole note is one image IS that image".
- Interaction — "Collapse folds a card to a CHIP and a section to its PILL" (arrow, peek, fold all) · "A plain double-click
  MAKES OR EDITS; ⌥-double-click OPENS" · "Arrow keys go IN and OUT" · "The card editor WRITES a little markdown" · "A SMART duplicate makes the NEXT card" · "A TAG is an OBSIDIAN tag" · "MERGING notes and BREAKING them apart are
  two DRAGS" · "`⌘A` selects everything ON THE CANVAS" · "Touch input" · "The grid QUANTISES" · "Smart guides PULL" · "The page runs EDGE TO EDGE"
  (`viewport-fit=cover`; every fixed control adds `--sa-t/r/b/l` back — read it before adding one).
- Storage — "The `store` adapter is the single swappable I/O boundary" (three adapters: OPFS, IndexedDB
  fallback, FSA) · "Boot order" · "External-change reload" · "The phone INBOX is a folder" ([docs/inbox.md](docs/inbox.md)).
- Colour and zoom — "ONE theme, FigJam's" · "The colour picker is FigJam's" · "Selection, ports and lines" · "The dock" · "A card's text colour is DERIVED from its
  fill" · "CORK is a SURFACE colour" · "Recently-used custom colours" · "Below `FAR_ZOOM`" · "The look: a FigJam board of sticky notes".
