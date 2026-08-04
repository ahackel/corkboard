# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first mindmap editor for a local folder of Markdown notes. Source lives in
`index.html` (the `<style>` + HTML shell) plus ES modules under `src/` (entry
`src/main.js`). A Vite build (`vite-plugin-singlefile`) bundles **everything back into
one self-contained `dist/index.html`** — JS and CSS inlined — so the *deployed* artifact
stays a single file and offline-via-HTTP-cache works the same as before. No runtime
dependencies; the only deps are the dev-time bundler. No tests.

## Running / developing

- **Run locally:** `npm install` once, then `npm run dev` (Vite dev server on
  `localhost:5173`, serves `src/` unbundled with HMR). OPFS (the local-first store)
  needs https/localhost, so use the dev server rather than a bare `file://`.
- **Build:** `npm run build` → `dist/index.html` (single self-contained file) plus
  `dist/help/` copied verbatim. `npm run preview` serves the built `dist/`.
- **TypeScript:** the whole codebase is `.ts` and **fully strict-typed** — every module,
  including `src/main.ts` (the canvas+editing core), is covered by `npm run typecheck`
  (`tsc --noEmit`, run after touching types). No `@ts-nocheck` remains; keep it that way.
  `allowJs` is on for safety but nothing is `.js` anymore; keep `.js` in import specifiers
  (Vite/TS `bundler` resolution maps them to `.ts`).
- **Help content lives in `public/help/*.md`** and is **embedded into the bundle at
  build time** (`import.meta.glob(..., '?raw', eager)` in `src/boot.ts`) — NOT fetched at
  runtime, so the help mindmap works even when `dist/index.html` is opened from a `file://`
  path (browsers block `fetch()` under `file://`). Edit help content there; dev HMR picks it
  up. There is no `manifest.json` — the tree is derived from each note's `mm_parent`.
- **Works in any modern browser** (incl. iPad Safari) thanks to the OPFS default. The
  "Open folder" option additionally needs the File System Access API
  (`showDirectoryPicker`), which only Chrome/Edge implement.
- **Hosting:** `.github/workflows/deploy.yml` runs `npm run build` and deploys `dist/`
  to GitHub Pages on push to `main` (Pages "Source" must be set to *GitHub Actions* in
  repo settings). The repo no longer serves a hand-written `index.html` directly.
- **No lint/test commands exist.** Verify changes by running the app in the browser and
  exercising the canvas.

## Core architecture

**Module layout (`src/`).** The app was split out of the old single inline script into
domain folders (all TypeScript). Pure functions live in `utils/`; the interactive subsystems
(drag, gestures, inline-edit, crud, attachments) are split into `features/` and share live
interaction state through the `ui` holder in `core/ui-state.ts`; `main.ts` keeps the render +
selection core and wires the global keyboard/toolbar events.
- `core/state.ts` — the shared mutable `state` object + domain types (`MindNode`, `View`,
  `AppState`, …) + DOM handles (`world`/`stage`/`edgesSvg`/`togglesSvg`) + `setStatus`.
- `core/ui-state.ts` — the shared mutable **`ui`** holder for the interactive subsystem
  (`drag`/`inlineEdit`/`bodyEdit`/`pan`/`marquee`/`pinch`/timers…) + their types, plus the
  `gPointers` map. Mutate its properties in place (never reassign `ui`) so drag / inline-edit /
  gestures / the render core all share one live interaction state across module boundaries.
- `utils/` — pure helpers: `markdown.ts` (`esc`, `renderBodyHTML`), `frontmatter.ts`
  (`parseMd`/`serializeMd`), `model.ts` (derived-tree queries), `zip.ts`, `idb.ts`.
- `store/` — **the swappable I/O boundary**, one concern per file: `opfs.ts`, `fsa.ts`,
  `idb-store.ts` (the three adapters, each `satisfies Store`), `handle-store.ts` (shared
  list/write/remove/read ops — DRY), `recents.ts`, `watch.ts`, `types.ts` (the `Store`
  contract), `index.ts` (barrel + `resolveOnDeviceStore`).
- `data/persistence.ts` — disk-I/O orchestration: the active `store` binding + `useStore`,
  debounced autosave (`scheduleSave`/`flushSave`/`saveAll`), `loadFromDir`, `reloadFromDisk`,
  import/export `.zip`. Signals recents-UI changes via `setOnRecentsChanged` (never renders UI).
- `view/` — `camera.ts` (pan/zoom/`fit`/`frameBox`), `layout.ts` (all node placement:
  `applyLayouts`/`effectiveLayout`/`collapseAtDepth`, the free/line/fan arrangements, a frame's
  flow modes (`frameFlow`), and the stack outliner (`stackOutline`/`stackDropTarget`/`stackOf`) +
  the container predicates `isFrame`/`isStack`/`isContainer`), `edges.ts`
  (parent→child connector geometry + `paintEdges`), `theme.ts`, `icons.ts` (loads
  `assets/icons/*.svg` via `import.meta.glob` `?raw`, fills `[data-icon]`).
- `features/` — the interactive subsystems split out of `main.ts`, each owning its concern and
  sharing state via `ui`: `drag.ts` (`bindNodeDrag` + clone/detach/auto-pan + reparent-by-drop),
  `gestures.ts` (canvas pan/zoom/marquee, registers its own listeners on import), `inline-edit.ts`
  (in-place title/body editing: `startInlineEdit`/`startBodyEdit`/`end…`), `crud.ts` (node
  lifecycle: `createNode`/`addChild`/`createSibling`/`duplicateSelection`/`delete…`/`extractToChild`),
  `attachments.ts` (image paste/drop, registers document listeners), `search.ts` (find box,
  exports `searchBox`), `images.ts` (inline image resolution).
- `boot.ts` — `boot()` (local-first open of the last map) + the home/storage screen + help store.
- `main.ts` — entry (`<script type="module" src="/src/main.ts">`). ~600 lines: the render core
  (`nodeEl`/`paintNode`/`paintAll`/`effectiveColor`/relayout animation), selection + edit-panel
  (swatches/layout chips/`selectNode`/`setSelectionSet`), read-only mode, focus, and the global
  keyboard/toolbar wiring. Imports each feature module and exports the kernels they call back
  (`paintAll`/`paintNode`/`selectNode`/`subtreeIds`/`nodeH`/`toggleCollapse`…) — deliberate,
  runtime-only `main`↔module cycles that Rollup bundles fine. Fully strict-typed.

NOTE: line numbers cited elsewhere in this file refer to the pre-split inline script and
are now only approximate — grep for the symbol.

**One `.md` file per node; the filename is the node's identity.** There is no
database and no sidecar file. In-memory node `id`s are ephemeral, minted fresh on
every load — never persist them.

**Edges are derived, never stored.** A node's parent is `mm_parent` (the parent
note's relative path) in its frontmatter; the tree and all edges are computed from
that. There is no edge list.

**A node's KIND is `mm_type`; its child ARRANGEMENT is `mm_layout`** — two separate axes, both
resolved by `foldTypeLayout` (`utils/frontmatter.ts`), which also folds legacy spellings so old
vaults keep loading. Kinds: `card` (the default, so it's omitted), `frame`, `stack`, `image`,
`annotation`, `query`. Only card/frame carry a layout (card: `inherit`/`free`/`line`/`fan`;
frame: `free`/`horizontal`/`vertical`); the rest never write `mm_layout`. The type/layout pickers
in `features/float-bar.ts` are driven by `NODE_TYPES` + `LAYOUTS_BY_TYPE` — a kind with an empty
layout set hides the layout trigger entirely.

**A `frame`'s BOUNDS include its title tab.** The title renders as a folder tab above the box's
top-left corner (`.node.frame > .title-row`, absolutely positioned), and `n.x/n.y/w/h` cover it:
`n.y` is the **tab's** top edge, the box element paints `FRAME_TAB_DROP` (= `FRAME_TAB_H - 1`, the
tab less its 1px overlap into the border) lower, and its inline height is `n.h` minus that drop.
So the tab is at a fixed offset from `n.y` in **both** collapse states — a folded frame is nothing
but that tab (`.frame-folded`, `isFrameFold`, rounded all round, `nodeH` = `FRAME_TAB_H`, width
measured), which is why folding no longer moves the title. `FRAME_TAB_H` is **40px** — a normal card's
padding and title metric, so the tab reads like a collapsed card — and it must equal what the CSS
actually renders, so the tab's `padding`/`font-size`/`line-height` are pinned in `styles.css` rather
than inherited from `.node .title`. Two consequences to respect: the tab must
stay a single ellipsised line (a wrapping one would make the box's position depend on a live
measurement — hence the hover tooltip in `paintNode` instead), and the vertical projection of a hosted
child into its host goes through `frameInsetY` (`view/layout.ts`) rather than a bare
`FRAME_BORDER` — `frameInterior`, `place`, `frameContentEl` and `followEdges` all share it (the X axis
has no such helper; it uses `FRAME_BORDER` directly), and `elTop` is the one place that applies the drop.

**A `stack` is an OUTLINER**, and the second container kind besides `frame`. It renders its whole
subtree as one indented, full-width column inside a box that is **width-resizable** (`n.w`,
defaulting to `STACK_W` = `NODE_W`) and auto-fitted in height, so **every descendant's own layout is
ignored** and a stack nested inside a stack is demoted to a plain row (`insideStack`). Its `h` is
derived by the layout pass and never persisted (`isBoxType` excludes it from `mm_h`); its `w` is
authored like any other kind's. Dropping into one is resolved on two axes by
`stackDropTarget`: the vertical position picks the GAP between rows, the horizontal position picks
the DEPTH there — so a straight drag only re-slots and nesting takes a deliberate sideways nudge.
It was briefly a card *layout* (`mm_layout: stack`); that spelling still migrates to the type.
Two invariants worth knowing before touching stack code: a stack row's measured height depends on
the width it renders at (text re-wraps), so `prepRow` paints a row **before** measuring it — and a
container's box size is only known *after* `applyLayouts`, so anything that paints before laying out
must paint again (see `withLayoutAnimation`). A row's width itself is **derived, not stored**
(`stackRowW`: the stack's own width, less the border/padding, less one `STACK_INDENT` per depth) —
deliberately, so it can't collide with the authored `n.w` a card carries in from outside the stack.
Drop a 400px card in and it renders as a stretched row while keeping its 400 for when it comes out.

**Layout lives in frontmatter as `mm_*` keys:** `mm_parent`, `mm_position_x`, `mm_position_y`
(relative to the parent; world origin for a root — see `commitRel`), `mm_side`, `mm_collapsed`,
`mm_type`, `mm_layout`, `mm_w`/`mm_h`, plus the card flags `mm_locked`,
`mm_done`, `mm_checklist` and `mm_query`. `parseMd` reads them; `serializeMd` writes them
back. Serialization rewrites **only**
app-owned keys (`tags`, `color`, `mm_*`) and preserves every other frontmatter
field and the note body verbatim — be careful to keep that property when touching
frontmatter code (`parseFM`/`fmSet`/`fmRemove`).

**Sizing: `n.w` is always AUTHORED; `n.h` only for the 2D box kinds.** Every kind can be resized
horizontally by dragging its left/right edge, and `n.w` (→ `mm_w`) is that dragged width and nothing
else — never a value some layout pass computed. Two axes' worth of handles come off that split
(`ensureResizeHandles`, `startNodeResize` in `main.ts`):
- `frame`/`image`/`query` are **2D boxes** — 8 hit-zones, authoring both `n.w` and `n.h` (→ `mm_h`,
  gated by `isBoxType`). For a **frame** these are its BOUNDS, i.e. they include the title tab:
  `mm_position_y` is the tab's top edge and the box itself starts `FRAME_TAB_DROP` lower.
- `card`/`annotation`/`stack` are **width-only** — 2 side zones (`EW_DIRS`), and their height is
  never authored, written inline, or persisted: a card/annotation measures it from its content
  (`nodeH` → `offsetHeight`) and a stack derives it from its outline. Minimum width is the kind's
  own natural width (`minWOf`), so a card only ever gets *wider*; drag back to it and `n.w` is
  dropped rather than persisting a redundant `mm_w`. An annotation is the exception that can also be
  narrowed (it shrink-wraps its text, so it has no fixed natural width — `naturalW` measures it with
  the authored sizing stripped, which is what makes narrowing possible at all).
Widening a width-only node changes its measured height as text re-wraps, so the resize gesture
paints *then* re-lays-out on every frame (same paint-before-measure rule as `prepRow`), and any
**annotation** attached to it is latched to the nearer border on each axis at pointerdown and rides
that edge — including the bottom edge, which moves on its own as the card re-wraps.

**The app is local-first.** It boots straight onto the canvas with the last map (no start
gate) via `boot()`; the start screen (`#startScreen`) is now a **home/storage panel** opened
by the home button (`#homeBtn`, house icon top-left) and closable (`startClose`).

**The `store` adapter is the single swappable I/O boundary.** All disk access
(`pick`, `openRecent`, `list`, `write`, `remove`, `watch`) goes through it. `store` is a
reassignable `let` (default `opfsStore`); `useStore(s, kind)` switches backend and records
`kind` in `localStorage` (`LAST_STORE_KEY`). Two implementations, same interface:
- `opfsStore` — **local-first default.** Origin Private File System (`navigator.storage
  .getDirectory()` → `vault/`), works on every browser incl. iPad. Same handle methods as
  FSA, so `list`/`write`/`remove` are identical; no picker/permission/watcher.
- `fsaStore` — File System Access API (Chrome/Edge only): a real local folder. `resume(key)`
  silently reopens at boot iff permission is still granted; directory handles persist in
  IndexedDB (`idbGet`/`idbPut`), the "recent folders" list in localStorage.
  `const HAS_FSA = !!window.showDirectoryPicker` gates the "Open folder" UI (`?nofsa` hides
  it to test the iPad-style layout on desktop).

**Boot order (`boot()`):** if last store was `folder` and `fsaStore.resume()` succeeds →
reopen it; else `openDevice()` (the OPFS vault). On-device is per-device — there's no
built-in cross-device sync. **Moving maps:** `.zip` import (`importFiles` → `unzip`, accepts
`.zip` or loose `.md`, strips a common top folder) and export (`exportZip` → `zipBlob`); the
inline ZIP reader/writer (store + `deflate-raw` via `DecompressionStream`) is zero-dependency.
Retargeting to an Obsidian vault or Tauri build means replacing only the `store` object —
don't scatter backend calls elsewhere. The focus/visibility reload is a shared listener
(`installWatch`) re-pointed at the active store (OPFS's `watch` is a no-op).

**Help mindmap:** `F1` opens `?help` in a new tab (`openHelpTab`). On boot with `?help`,
`openHelp()` switches to a read-only `helpStore` that serves the bundle-embedded `help/*.md`
notes (see the storage bullet above) — a real mindmap isolated in its own tab so the user's
vault is never touched. Titles carry a leading emoji (the filename is the title); the map goes
general→specific from a root welcome card, with each branch collapsed so users expand to go
deeper. Edit help content by editing those `.md` files; use backtick code spans, not raw HTML,
since `renderBodyHTML` escapes `<…>`, and avoid wrapping inline `code` in `**bold**`/`*italic*`
(the code span is extracted first, so the emphasis won't pair).

**Touch input:** pan/zoom on the canvas is a unified Pointer-Events gesture layer on
`#stage` (one finger pans, two fingers pinch-zoom + pan); node drag/reparent uses the
per-node pointer handlers in `bindNodeDrag`. `#stage`/`.node` set `touch-action:none`.
The edit panel has an **Actions row** (`#edRename`/`edDuplicate`/`edDragOut`/`edDelete`)
calling the same functions as the keyboard shortcuts; `updateNodeActions()` (run from
`applySelection`) enables/disables them by selection + `readOnly`, and the titles show
the shortcut. Add child/sibling live in the right-click context menu and on `Tab`/`Enter`.

**Central mutable `state` object (line ~377)** holds `nodes` (Map of id → node),
`view` (pan/zoom `{x,y,k}`), selection (`selId` + `sel` Set), `edgeStyle`,
`readOnly`, etc. The render pipeline is `paintNode` / `paintEdges` / `paintAll`;
DOM nodes live under `#world`/`#stage`, edges in the `#edges` SVG.

## Conventions that matter

- **Every mutation must call `scheduleSave()`** to persist. It debounces ~400ms and
  coalesces a burst of edits into one disk write (`flushSave` → `saveAll`).
- **`store.isOpen === false` means demo mode** — no folder open, saves are no-ops,
  in-memory layout changes are intentionally discarded.
- **`state.readOnly` disables all writes and edits** (collapse/expand still allowed);
  `scheduleSave` early-returns in this mode.
- **External-change reload:** `store.watch` fires `reloadFromDisk` on window
  focus / tab-visible (FSA can't truly watch files). It re-reads from disk but
  guards against clobbering in-progress typing/renaming and against re-reading the
  app's own recent writes (`state.lastSelfWrite`).
- **Markdown rendering is a small hand-rolled subset** (`renderBodyHTML`,
  `mdInline`, `mdLinks`, `mdEmphasis`) — headings, links, emphasis, task lists.
  It's not a full Markdown parser; extend these functions rather than reaching for a
  library (the no-dependency, single-file constraint is deliberate).
- **Theme** (light/dark) and **edge style** are persisted in localStorage and driven
  by CSS variables defined at the top of `<style>`.
