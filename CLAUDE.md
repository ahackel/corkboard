# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Corkboard** — a local-first visual editor for a local folder of Markdown notes. Source lives in
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
  runtime, so the help map works even when `dist/index.html` is opened from a `file://`
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
  `assets/icons/*.svg` via `import.meta.glob` `?raw`, fills `[data-icon]`; also holds `FOLDER_PATH`,
  the ONE folder outline every frame glyph is drawn from — the kind chip, all three frame layout chips
  (`features/float-bar.ts`) and a folded tab group's pill (`FOLDER_SVG`, `main.ts`) — since a frame IS
  a box with a folder tab on it. It lives there because neither of those two can cycle with it).
- `features/` — the interactive subsystems split out of `main.ts`, each owning its concern and
  sharing state via `ui`: `drag.ts` (`bindNodeDrag` + clone/detach/auto-pan + reparent-by-drop),
  `gestures.ts` (canvas pan/zoom/marquee, registers its own listeners on import), `inline-edit.ts`
  (in-place title/body editing: `startInlineEdit`/`startBodyEdit`/`end…`), `crud.ts` (node
  lifecycle: `createNode`/`addChild`/`createSibling`/`duplicateSelection`/`delete…`/`extractToChild`
  /`dropCardText`/`mergeCardsInto`), `text-drag.ts` (dragging a card’s selected text out of its
  editor — see the MERGING section below; registers document listeners),
  `attachments.ts` (image paste/drop, registers document listeners), `search.ts` (find box,
  exports `searchBox`), `images.ts` (inline image resolution), `breadcrumbs.ts` (`#scopeBar`: the
  open-frame path, the one way back out of an open frame — see the OPENING section below).
- `nav/` — where you ARE, as opposed to what the map is: `url-state.ts` (the hash — which map, which
  node, mode/camera/search/read-only, plus `open=`, the frame you're standing inside; the module
  header spells the shape) and `scope.ts` (the open-frame scope MODEL: the ephemeral holder, `canOpen`
  /`outOfScope`/`isScopeRoot`/`openPathTo`/`scopeRect`/`detachParentId`/`pruneScope`. It imports
  almost nothing, which is what lets `utils/model.ts` read it from inside `isHidden`).
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
frame: `free`/`horizontal`/`vertical`/`tabs`); the rest never write `mm_layout`. The type/layout pickers
in `features/float-bar.ts` are driven by `NODE_TYPES` + `LAYOUTS_BY_TYPE` — a kind with an empty
layout set hides the layout trigger entirely.

**A `frame`'s BOUNDS include its title tab.** The title renders as a folder tab above the box's
top-left corner (`.node.frame > .title-row`, absolutely positioned), and `n.x/n.y/w/h` cover it:
`n.y` is the **tab's** top edge, the box element paints `FRAME_TAB_DROP` (= `FRAME_TAB_H - 1`, the
tab less its 1px overlap into the border) lower, and its inline height is `n.h` minus that drop.
So the tab is at a fixed offset from `n.y` in **both** collapse states — a folded frame is nothing
but that tab (`.frame-folded`, `isFrameFold`, rounded all round, `nodeH` = `FRAME_TAB_H`, width
measured), which is why folding no longer moves the title. `FRAME_TAB_H` is **40px** — a normal card's
padding and title metric, so the tab sits on a collapsed card's metric — and it must equal what the CSS
actually renders, so the tab's `padding`/`font-size`/`line-height` are pinned in `styles.css` rather
than inherited from `.node .title`. **A frame is an outline and a label; the ONE thing that FILLS is a
DOCKED TAB — and the outline and the fill trade places between the two tab states.** The OPEN tab
(`.tab-active`) is outlined *and* filled solid in `--frame-stroke`: the sheet at the front of the folder,
holding the box below, so the folder's shape runs box → tab as one outlined thing. An INACTIVE tab
(`.frame-folded.docked:not(.tab-active)`) is the opposite — **fill only, at 62%, and NO border at all**:
it's a sheet tucked behind that front (which is literally where it paints, see the z-index rule), so the
canvas shows through it, and a rim of its own would draw three shapes where there is one folder. So the
strip reads as one outlined folder with soft colour patches behind its front sheet — not as a row of
boxes. Both halves of that are deliberate: a fill on every tab, because a row of bare outlines beside one
solid shape read as one tab plus some empty boxes when being a folder of sheets is the whole point of a
group; and semitransparency rather than the `opacity:.62` the element used to carry, which also faded the
title. Everything that is NOT a docked tab is a 2px outline in `--frame-stroke` over nothing: an expanded
frame's tab (so a lone frame reads as a labelled box, not a one-tab group), a folded frame, a folded
group's pill. Four knock-ons:
- **Every tab keeps the SAME BOX, and `FRAME_TAB_H` is spent three ways.** Widths are MEASURED off the
  element (`nodeW`) and `nodeH` just asserts `FRAME_TAB_H`, so any state that spends the 40px differently
  would slide every tab along the strip each time you switched which one was open. `box-sizing` is
  `border-box` and nothing sets a height, so `padding` + `border` + the 20px line must total 40: `8px/2px`
  for a pill; a docked tab drops the bottom border (that edge meets the box) and pays it back as
  `padding-bottom:10px`; an inactive one drops the border entirely and pays it back on BOTH axes
  (`padding:10px 12px` — the horizontal half is the easy one to forget, and it's 4px of drift per click).
  The active tab fills *behind* its border rather than dropping it (both `--frame-stroke`, so it
  rasterizes as one solid shape) for the same no-reflow reason. Change one and change the others. (2px,
  not the box's 4px: at this size a 4px rim eats most of the label.) The knock-on reaches the selection
  ring, whose `inset` pays for that border too: `-4px` on a bordered tab (an absolutely positioned child
  resolves against the PADDING box), `-2px` on a borderless inactive one.
- **A title with no fill under it is inked against what's BEHIND the frame** (`--tab-ink` ← `behindFill`
  in `main.ts`, set by `paintNode` on every frame), not against the frame's own colour: `var(--ink)`
  answers "what reads on this fill", which is the wrong question once the fill is gone. `behindFill`
  walks out through the containers that actually paint one (authorship-tested like `canvasFill`, since
  `.c-none` is transparent), stops at the open frame, and falls back to the canvas → the map colour →
  `THEME_BG`. A DOCKED tab is the exception that proves it: it has a fill of its own (62% or full), so its
  title goes back to `var(--ink)`, measured against that fill. What still reads `--tab-ink` there is its
  LOCK BADGE — that hangs 8px *outside* the tab, on the surface behind the group, which is why
  `behindFill` starts a docked tab's walk ABOVE its group rather than on it.
- **`isFrame` means an EXPANDED frame** (`view/layout.ts` — it tests `!collapsed`), and so, through
  `isContainer`, does every question built on it. Both of the "outline" rules above have to reach the
  FOLDED half too, which is why `paintNode` writes `--tab-ink` off the raw `n.type === 'frame'` and
  `inFrame` bails on `isFrameFold(n)` beside `isContainer(n)`. Get the second one wrong and a folded
  frame falls through to the plain-card branch and takes the `.frame-child` tint — whose `(0,3,0)`
  selector out-specifies `.node.frame-folded`'s own `background:none`, so the very pill meant to read as
  a bare outline is the one wearing a washed-out fill. (A docked tab is safe from that one by accident:
  its own fill rule is `(0,4,0)`. Don't lean on it — the ink and the tint would still both be wrong.)
- **A folded group's outline is its OPEN TAB's colour**, which is why `effectiveColor` redirects a tabs
  frame to `activeTab` unconditionally rather than only while expanded: the pill already wears that
  tab's title (`foldedTab`), so anything else would have one pill showing two tabs' identities. The
  knock-on is deliberate — the colour picker on a folded group still writes the GROUP (`actionTarget`
  doesn't redirect while folded), which now shows only when the open tab inherits, exactly as it does
  on an expanded one.
- **Only a TAB GROUP squares its top-left corner** (`.node.frame.tabs.has-tabs`, mirrored onto the
  content wrapper by `frameContentEl`). That square existed so a tab's straight left side met the box
  flush; an untabbed frame has no shape up there any more, so it's rounded all round like every other box.

Two more consequences to respect: the tab must
stay a single ellipsised line (a wrapping one would make the box's position depend on a live
measurement — hence the hover tooltip in `paintNode` instead), and the vertical projection of a hosted
child into its host goes through `frameInsetY` (`view/layout.ts`) rather than a bare
`FRAME_BORDER` — `frameInterior`, `place`, `frameContentEl` and `followEdges` all share it (the X axis
has no such helper; it uses `FRAME_BORDER` directly), and `elTop` is the one place that applies the drop.
The one frame that has none of this is the **OPEN** one (see the OPENING section below): no tab, no box,
no fill, its bounds are the viewport, and `frameContentTop` skips the tab drop for it exactly as it does
for a docked tab. Its wrapper is dropped by the same single lifecycle drop a fold uses.
**Anything that writes a node's `left`/`top` must go through `placeSelf` + `elTop`**, not a bare
`place()` — that's the pair `paintNode`'s own final branch uses, and the relayout ANIMATION
(`placeNodeEl`/`setNodeElXY`) writes left/top too, since interpolating them IS the animation. Skipping
`elTop` parks a frame's box at its bounds top instead of one tab lower, and because the box paints after
the tab strip (tree order — see `tabStripEl`), on a tab group that drew a big empty box straight over
its own tabs for the length of the transition; skipping `placeSelf` re-parents a docked tab's label out
of its group's strip for the same duration.
**A container's two side wrappers are LIFECYCLE-managed, not just created:** `frameContentEl` exists iff
`hostsContent(n)` (an expanded frame box, an expanded stack, or an OPEN docked tab) and `tabStripEl` iff
the node is an expanded tabs group — `paintNode` drops each the moment that stops holding. Being HIDDEN
counts as holding nothing (`hostsContent` returns false for it), which is what lets the wrapper's whole
lifecycle be ONE drop, placed ahead of `paintNode`'s `isHidden` early return rather than repeated inside
it: folding a group hides the open tab whose own wrapper would otherwise survive. Both created lazily, so a fold/reopen round-trips through the same code; a folded container's
children ride along detached and are re-placed by `place()` when it opens again. Skip the drop and a fold
strands an empty `overflow:hidden` div at the box's old size (same for a frame retyped to a card, or a
stack demoted to a row inside another stack).

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
An EMPTY stack still owes itself an `h`, and it can't be a constant: unlike a frame's single-line tab a
stack's own title WRAPS, so the height has to be measured (`sizeEmptyStack`, which paints then measures;
its height is the zero-row reduction of the `node.h` line that closes the stack branch — keep the two in
step). Both empty paths (no children at all / no visible rows) call it. `layoutSubtree` returns early for a
childless node, which is why that early return has to size a stack on the way out; without it a stack
kept `nodeH`'s `STACK_HEADER + STACK_PAD` fallback and a two-line title spilled out of its box.

**A frame with `mm_layout: tabs` is a TAB GROUP:** its child *frames* aren't content, they're TABS.
Their title tabs flow along its own top band (`tabStripRect`/`tabSlots`, DOM wrapper `tabStripEl`) and
whichever tab is OPEN borrows the whole box for its children — so the group owns the geometry (x/y/w/h,
border, resize handles) and a tab owns only its contents and its own tint. Zero new frontmatter keys: docking is
plain `mm_parent`, strip order is `mm_position_x` (`kidsByPosition` sorts tabs by x), and open/closed is
`mm_collapsed`. Four invariants hold it together:
- **A docked tab's bounds ARE its tab rect** — it takes the same render path as a folded frame
  (`isFrameFold` covers both; `isFrameBox` excludes it), and open vs closed differs only in
  `mm_collapsed` (which already hides its contents via `isHidden`) plus a CSS class.
- **Its contents live in the box its group lent it**, which is what `containerBox` spells — the single
  indirection, shared by `frameInterior`, `centreInFrame`, `frameContentTop`, the flow layout and
  `dropLanding`, so none of them has to know whether the frame it was handed is docked, **or OPEN**
  (whose box is the viewport — the scope branch comes FIRST there, or an open tab would keep the
  interior its group lent it). A group with
  tabs shows no tab of its own (`.tabs.has-tabs`): two docked frames must read as two tabs, not three.
- **At most one tab is open.** `normalizeTabs` (a pre-pass in `applyLayouts`) repairs it, `activateTab`
  /`openTabFlags` perform it, and every collapse-family path funnels through them — `toggleCollapse` on
  a tab OPENS it, and `focusNode` opens a closed tab rather than expanding it. Opening one is the single
  thing a LOCK doesn't forbid (it's how you look at the box, not a change to it), so a locked tab stays
  pressable — `dragPointerDown`'s `hasLockedAncestor` bail exempts docked tabs — while moving it is still
  refused. Its lock badge hangs 8px outside the tab, which is what `TAB_STRIP_PAD` leaves room for.
- **The strip's tabs must not carry a `z-index`.** `.tab-strip` deliberately has none so that plain tree
  order decides between a tab and the box (`tabStripEl` keeps the strip right BEFORE the box), which is
  what tucks an inactive tab *behind* the box like a sheet behind the front of a folder — the box's
  border and selection ring then run unbroken across the top of it. But a tab is a `.node`, and
  `.node { z-index:2 }` was quietly overriding that and lifting every inactive tab over the ring, which
  read as a ring chopped into pieces. `.frame-folded.docked` resets it to `auto`; only `.tab-active`
  takes one (5), which is what keeps the OPEN tab in front where its own three-sided ring joins the box.
- **A group and its open tab carry ONE fold button, and it's on the tab** — the title you can see. So
  `chipFace` gives the open tab the `'fold'` face and the chip's click handler redirects to
  `toggleCollapse(group)`; the group itself shows nothing while open, and takes the `'count'` face once
  folded, when it's a lone pill again and that `+N` is the only way back. A CLOSED tab shows neither (its
  contents are one click away in the box, and a badge would collide with the next tab along the strip).
  Since the two ring as one shape, `.sel-join` reveals the chip as well as `.sel` — selecting the BOX
  must not leave it with no visible way to fold.
- **A group holds no content of its own**, so anything added "to the group" goes to the open tab:
  dropped cards (`features/drag.ts`), `addChild`/`createSibling` and paste (`contentParent`). It has no
  COLOUR of its own either: `effectiveColor` starts the walk at the open tab, so the box (its border, its
  incoming edge, its outline swatch) is tinted by whichever tab is showing — which is also why
  `dockFrames` doesn't copy the target's colour onto the group. Unconditionally — FOLDED as well, where
  the pill's outline is the open tab's colour to match the open tab's title it's already showing — and a
  colour authored on the group is *not* an override: the walk continues from the tab THROUGH the group,
  so it just stands in for any tab that inherits. The two also ring as one shape when either is selected — `selJoin` hands the
  other half the ring (`.sel-join`), the tab's being three-sided like a plain frame's own tab.
- **A group doesn't exist from the user's side** — there are just tabs, one of them open. So a user-facing
  action on a selected group lands on the OPEN TAB via `actionTarget`: its colour + checklist (the
  float-bar properties' id provider), its rename (`startInlineEdit`, the single funnel for F2 / ⋯ / the
  outline) and its deletion (`deleteNode`/`deleteSelection`, after which `normalizeTabs` promotes the next
  tab and `dissolveEmptyTabGroups` takes the box away with the last one). The float bar goes there too —
  it centres horizontally on the LABEL, not the box (`labelRect`, `features/float-bar.ts`), since a
  frame's box can be many times wider than its title and the bar belongs over the thing you selected;
  for a group that label is its open tab's. An open group can't even BE the selection: `selTarget`
  (`main.ts`) maps it to its open tab in all three entry points (`selectNode`/`setSelectionSet`/
  `toggleSel`), so clicking the box selects the TAB — which is what makes the float bar show that tab's
  kind/layout/colour instead of a "group" nobody put there. What the box keeps is what it visibly owns,
  moving and resizing, and both had to stop asking `state.sel`: `dragPointerDown`'s marquee bail takes
  `selJoin(n)` as "selected" too (else the interior could only ever rubber-band and the box would be
  unmovable), while the resize handles are plain hit-zones that never needed a selection. `navArrow`'s
  `←` steps out of a docked tab to the GROUP's parent for the same reason — navigating onto a group
  would bounce straight back to the tab and read as a dead key.
  **Tabs are therefore made and unmade by DRAGGING only** (dock a title onto a tab; drag the last tab
  out and the empty box goes with it), and `mm_layout: tabs` is bookkeeping the user never picks:
  `LAYOUTS_BY_TYPE.frame` has no tabs chip, and `markChips` hides the whole layout row for any
  selection holding a tabs frame — a group has no arrangement of its own to choose, and a click there
  would silently dissolve it. That leaves `setType` as `undockAllTabs`'s one caller.
  A **folded** group is the one that stays selectable (a lone pill with no tab on screen, so nothing
  else could move or unfold it) — which is also the only place its kind picker and its lock are
  reachable, and where deleting it takes the whole group down instead of promoting the next tab.
  **Its own title is therefore never on the canvas, folded or not** (only in the outline, in search and as
  its filename): FOLDED, the pill shows the OPEN TAB's title (`foldedTab` in `main.ts`) with a folder icon
  in front of it (`FOLDER_SVG`, revealed by `.tabs-fold`) — so the text doesn't change under the fold, and
  the icon is what tells the pill from a folded plain frame — the job the minted `"<target> tabs"` title
  used to do in words (that title lives on, as the group's bookkeeping/outline name). Two knock-ons: `startInlineEdit` on a folded group UNFOLDS it first and then
  redirects (`actionTarget` only redirects while open, and an editor can't open on a `display:none` tab),
  and `toggleCollapse`'s status line names the open tab both ways round.
Dock, undock and re-slot all re-anchor the frame's contents through ONE formula (`reanchorContents`):
where they sat before the gesture (`interiorAtHome` — the lent box if it was already a tab, else its own
box at its pre-drag position), where they sit now, minus the drag delta its cards rode along with the
label. Drop that last term and re-slotting a tab — a gesture that doesn't change the box at all — leaves
its whole content offset sideways. Each frame's own `mm_w`/`mm_h` are never touched while docked, which is
what lets it come back out at the size it went in at. A group left with no children dissolves.
What may become a tab is `canBeTab`: a frame, or a plain CARD, which `dockFrames` turns into a frame on
the way in (`asFrame`) — so dragging a card onto a frame's tab docks it. The other kinds stay out and fall
through to the ordinary drop (they land in the box as content): an annotation holds nothing, and a
stack/image/query is a box whose own shape IS the point.

**A frame can be OPENED, and then the canvas IS its interior** (`nav/scope.ts` for the model,
`openFrame`/`exitScope`/`goToScopeDepth` in `main.ts` for the actions, `features/breadcrumbs.ts` for
the path). A frame is "a box with a folder tab on it", and this is the other half of that metaphor:
you can go in. While one is open, nothing but its contents is on the canvas, its own box/border/tab
are not drawn at all, its interior is the whole viewport, and the crumb bar is how you come back out.
Nesting is allowed. Distinct from `focusNode`, which is untouched: that frames a card WITHIN the map,
this replaces what the map is for as long as you're inside. What holds it together:
- **The scope is a second TERM in `isHidden`, not a second predicate** — one ancestor walk answers
  both "is a parent folded" and "is this outside the frame I'm in". That's what scopes the paint, the
  camera (`fit`/`frameBox` already filter it), the edges, the marquee, drag's every hit-test, the
  layout pass and the float bar in ONE edit across ~38 call sites. The scope root itself counts as
  outside its own scope, and *that* is why its chrome isn't painted: no per-kind rule, no CSS.
- **Nothing writes through that gate, and `applyLayouts` confines itself to the open frame.** The two
  terms differ in kind — a fold is persisted `mm_collapsed`, a scope is ephemeral — so the scope must
  never reach disk. The only mover keyed on `isHidden` is `layoutSubtree`, and while a frame is open
  `applyLayouts` runs it on the scope root ALONE. That single line is what stops opening a frame from
  dirtying a file outside it (and it's less work than the forest walk).
- **An open frame's children are FREE, whatever layout it carries.** `frameFlow` returns null for the
  scope root (and `effectiveLayout` already resolves a frame to `free`, so that's the only branch that
  had to be told), so a `horizontal`/`vertical` frame stops packing its contents into rows for as long
  as you're inside it: being in a frame should feel like being on the canvas, and a flow re-packing
  cards as you arrange them wouldn't. Leaving hands the flow back, which re-packs them into the box —
  so an arrangement made inside a flow frame isn't kept, exactly as a flow frame's positions are never
  the user's to keep anyway. The happy consequence: opening and leaving now move NOTHING, so a visit
  writes nothing to disk whatever layout the frame has.
- **The box becomes the VIEWPORT through `containerBox`/`frameInterior`**, as a DERIVED override.
  Hard invariant: the frame's own `n.w`/`n.h` are neither read there nor ever written, which is what
  lets it come back out at its authored size. `frameInterior` needs the guard too — a non-docked frame
  doesn't route through `containerBox` — and `frameContentTop` needs it because an open frame draws no
  tab to drop below (fixed there and NOT by making `isFrameBox` false for it: that feeds `nodeH`,
  which would then measure a `display:none` element and report a 64px frame).
  What still READS that rect, now the contents are free, is where a DROP lands: `dropLanding` clamps
  into `containerBox`, so without the override a card dragged across the open canvas would snap back
  into the frame's small authored box.
- **That rect is a SNAPSHOT at k = 1, refreshed only on a window resize** (`scopeRectFor`/
  `refreshScopeRect`). Sized at k = 1 — the app's canonical 1 world px = 1 screen px — rather than the
  live zoom, because opening then fits the camera, which would make a live reading circular; and a
  snapshot rather than a live rect so it can't change under a pan. `bottomInset()` is deliberately
  excluded: it tracks the SELECTION (the docked float bar), so folding it in would move the rect on
  every click. So is the crumb bar, which is floating chrome like `#toolbar`. It's anchored at the
  frame's own content origin, so the coordinates its contents already have stay meaningful.
- **Double-click is the way IN and the way OUT.** A frame's interior opens it; the empty canvas —
  which, once you're inside, is that same interior — leaves it (`features/gestures.ts`). At the top
  level there's nowhere to leave to, so the canvas keeps its original "new card here". The crumb path
  and `↓` are the other ways out.
- **The path is ONE pill, and the map name is its first segment** (`features/breadcrumbs.ts` +
  `#homeBar`). That's `#toolbar`'s pattern — one `--panel` capsule holding borderless items that
  highlight on hover — so going into a frame ADDS segments rather than swapping loose text for chrome.
  Segments carry no folder glyph (the `›` separators already say it's a path, and every segment but the
  map is a frame, so an icon on each says nothing), and the CURRENT one is inert: you're already there.
  A deep path folds its middle into one `…` that opens a menu of the levels it swallowed — which is the
  only thing that actually keeps it clear of the CENTRED `#toolbar`, since capping the pill's width
  can't: the separators are `flex:none` and simply overflow it.
- **The CANVAS wears the open frame's fill** (`syncCanvasBackground` → `--canvas-bg` on `#stage`, which
  sits under `#grid`; `<body>`'s `--bg` is left alone so the theme is untouched). Same resolver its box
  used — `effectiveColor` → `colorFill` — so the canvas can't disagree with the colour the box was just
  showing, and it's transitioned over `animateReflow`'s 320ms so going in reads as the canvas taking
  the colour rather than a cut — **except when the scope came from the URL**, where it must simply BE
  there (`withoutScopeFade` → `body.scope-instant`, which kills the transition for two frames). On a
  reload there's nothing to transition FROM, so the fade reads as the app flashing the wrong background
  before settling; on a back/forward step the camera and selection jump too, so a sliding background
  would be the only thing left catching up. Only when the colour is **authored** somewhere up the chain
  (`hasAuthoredColor`): `effectiveColor` falls back to the theme's neutral card fill for a frame nobody
  coloured, and painting the whole canvas *that* is both a lie and a real problem in the light theme,
  where the near-white swallows the chrome floating on the canvas. Authorship, not the hex — a frame
  explicitly coloured white still tints, an inherited colour still counts.
  **At the TOP level that same variable carries the MAP's own colour** — `state.canvasColor`, per-map
  in `settings.json` beside the grid, so it travels with the vault rather than the browser. One
  resolver answers both, `canvasFill` (`main.ts`), off `canvasOwner`: the open frame's `actionTarget`,
  or `null` for "the map". The `hasAuthoredColor` test applies only to the frame half — `canvasColor`
  is authored by definition, and `''` means the theme's background.
- **The canvas-colour BUTTON edits whichever of those two you're standing on** (`#canvasColorBtn`,
  one slot left of `#gridSizeBtn`; `features/canvas-color.ts`). At the top level it writes
  `state.canvasColor`; inside an open frame it writes that FRAME's `n.color` — the same field the
  float bar would write if the frame were selected, so nothing new exists for the case and the paint
  just follows. It reads `canvasOwner` too, which is what keeps the chip on its face showing the value
  it would overwrite. Four things to respect:
  - **The chips are `properties.ts`'s row, not a copy** — `swatchRowHTML`/`markSwatchRow`/
    `renderRecentChips` were split out of `createProperties` for exactly this, so the palette, the
    custom picker and the recents MRU have one implementation. What *can't* be shared is
    `createProperties` itself: that factory is defined over node ids, and at the top level the target
    isn't a node.
  - **The first chip differs, and that's the only difference** (`FirstChip`). A card INHERITS from its
    parent, so it gets the striped chip plus a separate explicit `none`. The map's canvas has no parent
    — its fallback is the theme — so it gets ONE "theme default" chip and no `none`, which there would
    mean the same thing twice.
  - **Both halves are undoable, in the one timeline.** A frame is an ordinary `record`; the map's
    colour isn't a node at all, so it goes through `touchCanvas`/`commitStep` — the shape the sketch
    layer already uses for `state.strokes`, and `Step` now carries a third optional `canvas` field.
    ⌘Z after a pick has to put the colour back wherever you were standing; a button whose undo depends
    on which scope you were in would read as a bug.
  - **The GRID INK is re-derived from whatever fill is behind it** (`syncCanvasBackground` writes
    `--grid-pat` on `#stage`, which `#grid` declares `--grid-ink` from). The theme's own recipe with
    the canvas fill standing in for `--grid` and, for `--text`, `inkFor(fill)` — the same call a card's
    ink goes through, so an arbitrary picked colour needs no special case. Without it a strong canvas
    colour either swallows the grid or turns it harsh.
- **`hostFrame` and `containerHost` are two different questions**, and the split exists because of the
  bullet above. `hostFrame` is a DOM fact — whose wrapper is my element inside — and it stops at the
  scope root, which hosts nothing. `containerHost` is a TONE fact — whose fill am I sitting on — and
  the open frame governs that more than ever now the canvas is painted its colour. `inStack`/`inFrame`
  (the `.stack-child`/`.frame-child` steps) must use `containerHost`, or the cards in an open frame
  lose their step and vanish into a canvas painted the very colour they inherit.
- **`hostFrame` stops at the scope root**, so its children are placed straight under `#world`,
  unclipped — that's what makes "the box isn't there" true of the DOM and not only of the paint. Its
  `.frame-content` wrapper is dropped by the existing ONE drop in `paintNode` (it's `isHidden`, so
  `hostsContent` goes false), and `edges.ts` shares the walk, so the connectors unclip in step. The
  `hostFrameId` cache must be cleared on every scope change or elements keep being placed into a
  wrapper that's about to go.
- **Leaving GROWS a free frame to hold what you put in it** (`growToFitContents` → the same
  `fitFrameToContent` that ⇧A runs), and only when something really sticks out. Inside, the whole
  viewport was fair game, so a card can easily end up outside the box it goes back to being — where
  `overflow:hidden` would clip it into invisibility. FREE frames only, and that's load-bearing: a flow
  frame re-wraps into its own box in the `applyLayouts` that FOLLOWS this, so measuring here would see
  a row that's about to fold itself up and widen the box to fit it, creeping wider on every visit.
- **The stack IS the crumb path** (`openPathTo`), not just what you clicked through — so opening a
  deep frame from the ⋯ menu still reads `Map › A › B › C`. Levels you really stepped through remember
  their camera and selection, so leaving one glides back to it; levels rebuilt from a URL don't
  (their ids are gone), so leaving those re-fits instead. The stack is session-only; the hash carries
  only the innermost level.
- **Opening is NAVIGATION, so it isn't undoable** — same class as `revealInView`, and it writes no
  node field. The two things around it that DO are recorded separately: unfolding a collapsed frame on
  the way in, and the grow-to-fit on the way out. So ⌘Z re-folds or un-grows without teleporting you
  between scopes. Allowed in read-only and on a LOCKED frame (`activateTab`'s exemption: looking
  inside the box isn't changing it) — though the double-click route still folds in read-only, since
  `activateNode` short-circuits there, leaving `↑` and the ⋯ menu as the ways in.
- **"No parent" means the OPEN FRAME** (`detachParentId`) — for `createNode`, `createDetachedNode`,
  a paste's payload roots, the outline's `makeRoot`, and a card ripped out of a NESTED frame. A real
  root would land outside the scope and simply vanish. One helper, read at all five.
- **You can't drag a card out of the frame you're in**: `centreInFrame` returns true for the scope
  root (its interior is the whole canvas, so there's nowhere visible to rip to), and one guard keeps
  the rip preview and the commit agreeing as the file insists. The way out is to leave first, or the
  outline's "Move to…" picker — which stays map-wide precisely for this. The asymmetry is deliberate:
  moving a card out is a thing you asked for, dragging into nowhere isn't.
- **Search and the outline are scoped; query cards, wikilinks and undo are not.** Search finds what's
  on the canvas, so every hit can be shown and selected, and `sortedRoots` makes the outline's top
  level the open frame's children (which is also what makes dropping a row beside a top row mean "put
  it here"). The map-wide jumps come OUT of as many levels as it takes first (`popScopeFor`), because
  `isSelectable` refuses an out-of-scope id and the step would otherwise look dead.
- **The open frame is never folded, and never missing.** `applyLayouts` repairs the first beside
  `normalizeTabs` (a reload or an undo can re-collapse it, and `layoutSubtree` bails on collapsed —
  a blank canvas being the worst failure here, `isHidden` checks scope-root identity BEFORE the fold
  as a third layer). `pruneScope` handles the second in the same pass, truncating the stack to what
  survives; the camera half of that recovery lives in `syncScopeChrome`, which needs the camera.
  A reload re-mints every id, so `resolveScopeAfterLoad` re-points the stack by FILE before the first
  layout — deliberately not cleared like the undo history, since a background refocus reload must not
  kick you out of the frame you're working in.
- **Only frames, for now, but the mechanism is kind-agnostic:** `canOpen` is the one kind test —
  widen it there, never at a call site. A stack is a container that stays out (it's an outliner, not a
  box you stand in), which is why `activateNode` keeps `addChildIn` for it. Opening a tab GROUP opens
  its OPEN TAB (`actionTarget`) and the crumbs skip the group, since from the user's side it doesn't
  exist. Ink stays visible but is left out of the framing, or opening a frame would zoom back out to
  take in a stroke on the far side of the map.

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

**Help map:** `F1` opens `?help` in a new tab (`openHelpTab`). On boot with `?help`,
`openHelp()` switches to a read-only `helpStore` that serves the bundle-embedded `help/*.md`
notes (see the storage bullet above) — a real map isolated in its own tab so the user's
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

**Collapse has FOUR entry points, all funnelling through `toggleCollapse`/`toggleCollapseSelection`:**
the corner chip, `X`, the ⋯ menu, and the `←`/`→` arrow keys — which unlike the other three are
DIRECTIONAL rather than toggles (see the arrow-keys section below). (Double-click used to be one too —
it now OPENS a node instead, see that section.) The **chip** is `.hidden-count` — one
`<button>` at the node's top-right with two faces: folded it reads `+N` (the hidden-descendant count,
a bare `+` when only a body is tucked away), expanded it shows a chevron, and *that* face is revealed
only on hover or while SELECTED (the touch story: tap the card, tap the chip — and every card of a
multi-selection carries one, whose click folds them all like `X` and `←`/`→`, without reducing the
selection first).
**`paintNode`'s `chipFace` is the single thing that decides which face shows** — `styles.css` keys off
nothing but the `data-chip` it writes (`'count'`/`'fold'`/absent), and *no per-kind rule may hide the
bubble*. BOTH faces live in the button permanently (`nodeEl` bakes the chevron in beside a `.cnt` span)
and `data-chip` picks which is visible, so `paintNode` never rewrites the chip's `innerHTML` — re-parsing
that `<svg>` per foldable node per paint is real work, and `paintAll` runs once per animation FRAME for
the length of a resize drag. Which node the button ACTS on is `chipTarget` (itself, or a docked tab's
group), read by both `chipFace` and the click handler so the button shown and the node folded can't
disagree. The no-per-kind-rule part is why `.hidden-count` no longer appears in the frame/stack/
image-card/query-card/docked-tab rules. That's not tidiness: `.node[data-chip="fold"]:hover:not(:has(.node:hover))`
out-specifies any plain class selector, so a rule like `.node.locked > .hidden-count { display:none }`
silently loses on hover. Anything that shouldn't offer the button gets refused in `chipFace` instead —
annotations (an annotation IS its body, so folding leaves an empty shell), image/query cards, and
**locked** nodes (`toggleCollapse` refuses them, so the control would do nothing — their folded *count*
still shows, being information rather than a control). A frame's/stack's own body is never rendered, so
only children make one collapsible.
**The chip lives INSIDE `.title-row`** (hence the `> .title-row >` in every one of its selectors), and
that's what puts both faces in the same spot in every state — hanging 8px off the TITLE's top-right
corner — so folding never moves the button: the row is the containing block exactly when it's
positioned, i.e. when it's a frame's title TAB, so a frame's chip rides its tab instead of sitting
`FRAME_TAB_DROP` lower on the box, and a folded frame / docked tab (whose label IS the element) needs
no special case. Where the row is in flow the offsets resolve against the node's own padding box, so a
bordered box adds its border back (`.stack` → `-12px`).
Two more things to respect: the hover rule needs
`:not(:has(.node:hover))` because child cards are DOM-nested (a deep hover would otherwise light up
every ancestor's chip at once), and the chip's `pointerdown` must `stopPropagation` so `bindNodeDrag`'s
`el`-level handler never turns the click into a select/drag — the touch double-tap counter in
`features/drag.ts` exempts it (via `NODE_CONTROLS`) for the same reason.

**Double-click / double-tap OPENS a node (`activateNode` in `main.ts`)** — folding moved to the chip,
which freed the gesture for what a double-click means nearly everywhere else. One gesture, dispatched
by WHAT WAS HIT, so it covers every kind without a per-kind entry point: a `.title-row` (a card's title
row, a frame's folder tab, a docked tab's whole label) renames via `startInlineEdit` — the single
rename funnel, so the tab-group/annotation/query redirects and the lock refusal come for free; anything
else on a card edits its note; a FRAME's interior OPENS it (`openFrame` — see the OPENING section
above: the folder metaphor's own gesture, and the only one that reads as "go in"); any OTHER
container's interior — i.e. a stack, which `canOpen` refuses because an outliner is not a box you can
stand in — gets a new card THERE (`addChildIn` → `addChild`, which routes a group to its open tab,
refuses a locked parent and reveals a folded one). Adding a card inside a FRAME kept `Tab`, the ⋯ menu
and the canvas right-click. The same gesture on empty canvas creates a root card (`stage`'s `dblclick`
in `features/gestures.ts`) — **or, while a frame is open, LEAVES it**, since the canvas then IS that
frame's interior and this is the inverse of the double-click that took you in. Going in and coming out
being one gesture is most of what makes a frame feel like a folder; making a card inside an open frame
moved to `Space`, `Tab` and the canvas right-click, which all land it in that frame
(`detachParentId`). Five things hold it together:
- **The INNERMOST node owns the gesture, including the ones it declines.** Child cards are DOM-nested,
  so both handlers (`nodeEl`'s `dblclick`, the touch double-tap in `features/drag.ts`) `stopPropagation`
  BEFORE their bails, not after — otherwise a gesture this card refuses bubbles to its host card, which
  reads it as a double-click on itself. That's what broke renaming: double-clicking a word inside an
  open title editor (the ordinary way to fix one word of a name) reached the host and opened the HOST's
  note editor, which closed the rename and sent the rest of the typing into the parent's body. On touch
  it's worse, since each ancestor keeps its OWN tap counter and so sees the same two taps. A container's
  children are exempt by construction — they live in its sibling `.frame-content` / `.tab-strip` wrapper,
  not inside its element.
- **`NODE_CONTROLS`** (exported from `main.ts`) is the one list of things that act on a SINGLE click —
  chip, checkboxes, links, `.addnote`, query input, resize handles `.fh`. Both the `dblclick` handler
  and the touch double-tap counter in `features/drag.ts` bail on it, or the second click would fire the
  button AND open the card.
- **A folded node is nothing but its title** (`.node.collapsed .body { display:none }`), so EVERY hit on
  it renames — otherwise a double-click would open an editor inside a hidden `.body`.
- **Read-only keeps the old meaning** (fold/unfold, the one thing the mode allows): there's nothing to
  open, and browsing the help map is all expanding. Note this short-circuit sits ahead of everything,
  so a read-only double-click on a frame FOLDS it rather than opening it — `↑` and the ⋯ menu are the
  routes in there (opening itself is allowed in read-only; it mutates nothing).
- **A click now only ever SELECTS.** The 260ms slow-second-click rename is gone, and with it the
  `ui.renameTimer` every fresh interaction had to `clearTimeout`, the `ui.pendingGroupFold` stash that
  let a double-click fold a just-reduced multi-selection, and `Drag.downTarget`. Don't reintroduce a
  timer here: it can only race the double-click it was invented to lose to.

**MERGING notes and BREAKING them apart are two DRAGS, not two commands** — deliberately, and it's
the one place this app parts company with its closest precedents (Scrivener's `Documents ▸ Merge` +
`Split at Selection`, Ulysses' `Merge Sheets` + `Split at Selection`, both list commands on a
multi-selection). There is no menu entry and no shortcut for either, and adding one is a decision, not
a gap: what a canvas has that a binder doesn't is a place to point at. Neither writes a new frontmatter
key — a merge is a body edit plus a delete, a break is a body edit plus a create.
- **⌥-drop card(s) onto a card MERGES them into it** (`mergeDrag`/`cardMerge` in `features/drag.ts`,
  `mergeCardsInto` in `crud.ts`). The card you dropped ONTO survives — it keeps its id, its file, its
  colour, size and flags — and each dragged note folds into its body as `## Title` then its text, in
  the order the cards were selected. Tags are unioned in (a tag labels content that just moved); their
  CHILDREN come up onto the target rather than going with them, since merging notes must never take a
  branch with it. `canMerge` is the ONE kind test, and it answers for both sides of the gesture: a
  plain card or an annotation (which contributes text and no heading, and takes none either — an
  annotation IS its body). Every other kind is a box or a leaf whose own shape is the point, so folding
  it into a body would throw away exactly what it is. Merging INTO an annotation is the one case that
  needs its own line (`kidHome`): an annotation is a LEAF — `isLeafType`, it never adopts children — so
  the swallowed cards' children go to the card that annotation is PINNED to (or the top level), which
  is where they'd have gone had the annotation not been in the way.
  It is the **image fold's twin** (`imageMerge`/`foldImageCardsIntoBody`), resolved in the same branch
  chain and previewed with the same `.drop-merge` dashed outline, and that's what makes ⌥ affordable
  here: the modifier's ordinary meaning (detach to root) applies when there's nothing valid under the
  cursor, so nothing was displaced — the plain drag still reparents, ⇧ still clones, ⌘ still toggles
  the selection. The centre/edge zones on a card were already spoken for (sibling/child), which is why
  this needs a modifier at all. One knock-on: `paintDetachPreview` (⌥ pressed mid-drag) now goes
  through `dragFollow`, so the target's outline appears on the KEYPRESS rather than on the next mouse
  jiggle — ⌥ no longer only means "detach", so repainting the dragged subtree alone is no longer the
  whole preview.
- **Dragging a card's selected text OUT of its editor BREAKS it apart** (`features/text-drag.ts` →
  `dropCardText`), after Heptabase's whiteboard gesture: drop it on empty canvas and it becomes a card
  of its own, drop it in a container and it becomes a card THERE, drop it on another card (or an
  annotation) and it's appended to that note. Always a MOVE — the text leaves the source, whose editor
  is DROPPED rather than ended, since `endBodyEdit`/`endInlineEdit` would write the editor's stale
  value straight back over what was just cut (`dropInlineEdit` is that teardown for the title).
  **Either half of a card can be the source** — its note or its TITLE — and `TextSource`
  (`{id, part, start, end}`) is what says which, captured at `dragstart` and read back live at the drop
  (`liveText`), since the offsets are into what the EDITOR shows, not into `n.title`/`n.body`. The two
  differ in three ways and nowhere else: a contenteditable has no `selectionStart`, so a title range is
  measured off a `Range` (`selectedRangeIn`); a title is one line, so the new card gets it as a title
  and no body; and a title is the card's FILENAME, so `cutTitleRange` can REFUSE — what's left has to
  stand as a title on its own (`titleProblem`, and never empty), and when it wouldn't, nothing is cut
  and nothing is created rather than the gesture half-happening. `.title.editing` also has to opt out
  of `.node`'s `user-select:none`: a browser forces selection inside a contenteditable anyway, but the
  inherited `none` is enough to make dragging that selection out unreliable.
  **Where the new card belongs is ONE rule read both ways: the box you dropped in governs.** Dropped in
  a container, it's that container's child. Dropped on the open canvas *from a card that lives in a
  container*, it goes to the TOP LEVEL (`detachParentId`) — dropping on the canvas is how a note comes
  OUT. That second half is what "a sibling of the source" got wrong: it parented the card back INSIDE
  the box, so dragging text out of a stack's row put a new ROW in the outline instead of a card where
  you dropped it, and out of a frame's card put one at a drop point the box's `overflow:hidden` clipped
  away to nothing. Only a source already on the canvas keeps the sibling reading (slotted right after
  it, like `createSibling`), so the new card joins the branch it was cut from. The "am I in a box" test
  is `hostFrame`, and it's the right one precisely because it stops at the scope root: inside an OPEN
  frame there is no box to come out of — that frame IS the canvas — so its cards stay siblings. `titleAndBodyFrom` gives the new card its title
  from the first non-blank line (marker stripped), which is what `⌘⇧E` already did implicitly and is
  now shared with it (`splitTitleText`).
  **What rides the cursor is a CARD** (`buildGhost` → `setDragImage`, `.node.drag-ghost` in
  `styles.css`): the default drag image is a translucent snapshot of the dragged LETTERS, which reads
  as moving text around, when the whole point of the gesture is that a card comes out of it. So the
  ghost is a real `.node` carrying the title the new card would get — the same `splitTitleText` reading
  the drop will make — tinted with the SOURCE card's resolved colour, since a sibling is what the text
  becomes and it would inherit exactly that. It has to be IN the document for the browser to snapshot
  it during `dragstart`, so it's parked off-screen horizontally (`display:none`/`visibility:hidden`
  snapshot as nothing, and moving it off vertically only would keep its width) and removed on the next
  tick — removing it inside the handler can beat the snapshot.
  This rides the browser's NATIVE text drag (a textarea selection is draggable for free) rather than
  the pointer machinery in `drag.ts`, which is what keeps it out of that file's gesture vocabulary
  entirely — at the cost of being desktop-only, leaving `⌘⇧E` (extract to a child) as the way to break
  a note apart on iPad. **A card element being `draggable` (the ⌥ card-file export,
  `features/clipboard.ts`) gets in the way of this twice, and each half needs its own answer.**
  · A draggable ANCESTOR is decisive about what a drag begun inside it drags: the browser resolves it
  as that ELEMENT's drag, so a selection can never come out of the contenteditable TITLE while it
  holds. A `<textarea>` is the exception that hid this — a text control with a selection outranks the
  ancestor — which is why the note half worked and the title half could not. So `setCardDraggable`
  turns it off for as long as an editor is open on that card (every teardown puts it back); exporting a
  card mid-rename isn't a gesture anyone can be making. `.title.editing` also opts out of `.node`'s
  `user-select:none` for good measure.
  · That same `dragstart` handler **cancels every native drag it doesn't own**, so it must also stand
  aside for this one — `cardTextDrag` is the shared resolver, and it tests the CARD the drag began on,
  not just "some editor is open", or an editor left open elsewhere would make that card's export (or an
  ⌥ image extract) stand down. And the drag DATA is left to the browser:
  the one drop we don't handle is the selection dragged back into its own note, which is a plain
  in-textarea move and must stay one (hence `destAt` returning null for the source card, editor or not).

**Arrow keys go IN and OUT, and fold and unfold (`navArrow` in `main.ts`):** `↑` opens the selected
frame, `↓` leaves the open one, `→` unfolds, `←` folds. All four are about DEPTH, in the two senses
this map has — which folder you're standing in, and whether a branch is showing. **Walking siblings
and stepping onto a child lost their keys to that**, deliberately: opening a frame is now the primary
way to move around a big map, and clicking (or the outline, a real tree widget) covers siblings. So
`navSiblings`/`navTo` are gone, and the keys no longer pan — `↑` re-frames via `frameBox`, `↓` glides
back to a remembered camera, `→`/`←` don't move the camera at all (`revealInView` survives for its
other callers). They were never geometric and still aren't: a child's side is its own stored
`mm_side`, so a fan branch has children on two sides at once and "left" would stop meaning anything.
Two details: `←`/`→` are DIRECTIONAL rather than toggles (pressing `→` twice can't fold what it just
unfolded, and a MIXED selection lands on one state in a single press instead of needing two), and `←`
on an OPEN docked tab folds its GROUP, exactly as its corner chip does (`chipTarget`). They act on the
WHOLE selection via `setCollapsedSelection` — the directional sibling of `toggleCollapseSelection`,
both filtering through one shared `foldableSelection` so the chip, `X` and the arrows can't disagree
about what counts. A keyboard fold has no business reaching fewer cards than a click does; `↑` is the
one that stays single, since you can only stand in one frame. Because the directional form skips cards
already in the target state, its undo step covers exactly what it changed — undoing a `←` doesn't
spring open a card that was folded before you pressed it. `↓` reads the SCOPE, not the selection, so it still works right after clicking empty
space to deselect — which is exactly when you want to go up; it's silently inert at the top level,
since a status line there would nag on every repeat press.

**`⌘A` selects everything ON THE CANVAS** — which, inside an open frame, is that frame's contents and
nothing else. It needs no scope test of its own: `isHidden` already means "on the canvas right now"
(covering both the open frame and folded branches), and `setSelectionSet` drops whatever isn't
selectable. Guarded by `isTypingInField`, since in a field `⌘A` belongs to the field.

**Central mutable `state` object (line ~377)** holds `nodes` (Map of id → node),
`view` (pan/zoom `{x,y,k}`), selection (`selId` + `sel` Set), `edgeStyle`,
`readOnly`, etc. The render pipeline is `paintNode` / `paintEdges` / `paintAll`;
DOM nodes live under `#world`/`#stage`, edges in the `#edges` SVG.
The open-frame scope is deliberately **not** in here (it lives in `nav/scope.ts`): `state` is the MAP —
every field is either the notes themselves or something mirrored to disk/localStorage and restored on
load — whereas a scope is where you're STANDING. It never reaches frontmatter, it's mirrored only into
the hash, and its camera stack is session-only.

## Conventions that matter

- **The app is called Corkboard; it used to be called "mindmap", and that name survives in exactly
  three places on purpose.** Everything the app persists outside the vault is now prefixed
  `corkboard.` (localStorage) or named `corkboard`/`corkboard-vault` (IndexedDB), and neither kind
  of name can be renamed in place — so both are carried over ONCE: `utils/legacy-keys.ts` sweeps the
  `mindmap.*` keys on import (imported FIRST in `main.ts`, since `initEdgeStyle`/`setupTheme` read
  settings while `main.ts`'s own body evaluates), and `openRenamed` (`utils/idb.ts`) copies a legacy
  database into the new one on its first open, guarded on the new store being EMPTY so it can run
  only once and can't overwrite fresher data. What must NOT be renamed: the notes' **`mm_*`
  frontmatter keys** — that's the file format, not the product, and a vault has to keep opening in
  Obsidian and in older builds. The clipboard marker splits the difference: it WRITES
  `<!-- corkboard-card: … -->` and READS both spellings (`features/clipboard.ts`), so a payload
  copied from an older tab still pastes as cards. Use the word "map"/"board" for the document
  (`store.name`, the registry, `mm_*`) and "Corkboard" only for the product.
- **Every mutation must call `scheduleSave()`** to persist. It debounces ~400ms and
  coalesces a burst of edits into one disk write (`flushSave` → `saveAll`).
- **`store.isOpen === false` means demo mode** — no folder open, saves are no-ops,
  in-memory layout changes are intentionally discarded.
- **`state.readOnly` disables all writes and edits** (collapse/expand still allowed, and so is OPENING
  a frame — it mutates nothing); `scheduleSave` early-returns in this mode.
- **Visibility has ONE gate, `isHidden`, with TWO terms:** a collapsed ancestor (persisted as
  `mm_collapsed`) and the open frame's scope (ephemeral, `nav/scope.ts`). Nothing writes through it.
  The only *mover* keyed on it is `layoutSubtree`, and `applyLayouts` confines that to the current
  scope — which is exactly what stops opening a frame from dirtying a single file outside it. Add any
  new visibility term IN there, never beside it: ~38 call sites already mean "is this on the canvas
  right now", and a second predicate would have to be kept in agreement with all of them.
- **External-change reload:** `store.watch` fires `reloadFromDisk` on window
  focus / tab-visible (FSA can't truly watch files). It re-reads from disk but
  guards against clobbering in-progress typing/renaming and against re-reading the
  app's own recent writes (`state.lastSelfWrite`).
- **Markdown rendering is a small hand-rolled subset** (`renderBodyHTML`,
  `mdInline`, `mdLinks`, `mdEmphasis`) — headings, links, emphasis, task lists.
  It's not a full Markdown parser; extend these functions rather than reaching for a
  library (the no-dependency, single-file constraint is deliberate).
- **Below `FAR_ZOOM` (50%, `view/camera.ts`) every overlay badge is dropped** — `applyView` puts
  `zoom-far` on `<body>` and `styles.css` hides the fold chip, the lock badge, the emoji tag row and
  the `.addnote` pen: a few unreadable pixels each at that scale, times every card on screen. Purely a
  CSS mode (no node geometry depends on it, so crossing the line needs no repaint), and the hides need
  `!important` — those controls are revealed by `:hover`/`.sel`/`[data-chip]` selectors no plain class
  can out-specify. Add any new card-corner badge to that rule. Page CHROME is not in scope for it and
  must not be added: `#scopeBar`'s crumbs stay legible at every zoom, since being zoomed out is exactly
  when you most need to know which frame you're standing in — the rule is about per-CARD badges, of
  which there is one per card on screen.
- **Theme** (light/dark) and **edge style** are persisted in localStorage and driven
  by CSS variables defined at the top of `<style>`.
- **ONE card palette for both themes.** `body.light` overrides no `--pal-*` value (it used to swap in
  a brighter pastel set), so a card is the same colour wherever the map is opened — and therefore has
  one ink, decided by the colour itself. `refreshPalette` still re-reads on a theme toggle (a no-op
  now, kept so a future per-theme colour would still work) and still repaints, because what *does*
  differ per theme is `effectiveColor`'s fallback for an uncoloured card / an annotation, plus
  `c-none`'s ink.
- **A card's text colour is DERIVED from its fill, never authored.** The palette hexes are still
  the `--pal-*` custom properties in `styles.css` (one source of truth, read into JS as
  `SWATCH_BG`), but the **ink** each one demands is computed: `utils/ink.ts` measures WCAG contrast
  and `main.ts`'s `deriveInk` injects a `--pal-ink-*` + `--pal-scrim-*` pair per key into a
  generated `<style>` (re-run by `refreshPalette` on theme toggle, since the two themes have
  different fills). The `.c-*` classes hand those to a card as **`--ink`** (its text colour) and
  **`--scrim`** (what an in-place editor paints *behind* that ink). Three rules follow:
  - **No rule anywhere may name a colour key to fix its text.** One `color: var(--ink)` per surface
    that wears a `.c-*` class (`.node`, `.query-item`, `.oc-card`, `.ol-row`) covers every colour in
    both themes — that replaced four hand-maintained "which keys are exceptions" lists that all had
    to agree with each other, and it's what lets an off-palette colour work with no new CSS.
  - **`--scrim` is paired with the ink, not fixed.** Every editor backdrop (`.title.editing`,
    `.body-edit`, `.query-input`, `.oc-title:focus`, `.ol-title.editing`) uses it: a hardcoded dark
    scrim under dark ink is unreadable. Same reason the body's marks (`code`, `pre`, `blockquote`,
    `hr`, image placeholders) tint with `color-mix(… var(--ink) …)` instead of a literal white/black.
  - **Ink is a property of the CARD, not of the theme** — which is why the ink hexes are fixed and
    `body.light` no longer overrides text anywhere. `c-none` is the one exception, and by
    construction: with no fill there's nothing to measure, so it takes `var(--text)` and has its
    scrim flipped by hand. Ink is computed from a container's *own* fill; a stack's `86%`-toward-black
    step and the `93%`-toward-`--ink` step its rows and a frame's child cards take are not
    re-measured (all stay legible — the stack's darkened fill is the thinnest at ~3.2:1 on a bold
    title).
  - **A card inside a container steps one notch off its host's fill** — `.stack-child` for a stack's
    rows, `.frame-child` for the cards in a frame's box (`inStack`/`inFrame` in `main.ts`, nearest
    container ancestor by **`containerHost`** — the TONE walk, deliberately not `hostFrame`, so an
    OPEN frame still steps its cards even though it hosts no elements; see the OPENING section).
    Both exist for the same reason: a card INHERITS its colour from its
    ancestors, so one dropped into a coloured container resolves to the container's own fill and
    vanishes into it. The step is `93%` toward that card's own **`--ink`**, not toward a literal
    `#fff`: `--ink` is by construction the direction that HAS contrast against this fill, so it
    always lands where there's room. White has none on a pale fill — the light theme's default card
    is `#f2f4f7`, whose row came out ~1 unit off it, i.e. flat. Nothing that used to step visibly
    changed, and that's structural rather than lucky: `INK_MIN` hands out dark ink only *below* its
    contrast floor, i.e. on exactly the fills too pale for a white step to show, so the two switch
    over together. Only plain cards take the tint (`inFrame` refuses the rest) — a nested container
    or box already owns its own tone, and an annotation never inherits a colour to begin with.
  The bias is deliberate: light ink is kept unless its contrast falls below `INK_MIN` (**2.5**)
  rather than always taking the higher contrast, and that one number serves both themes. It's pinned
  low enough that **every palette colour keeps the ink it had before any of this existed** (the
  lowest being the dark theme's amber at 2.85), so dark ink is reserved for fills genuinely too pale
  for white — the off-palette case this is all for. No single threshold can also flip the light
  theme's pale fills, which is what the old per-theme hand-written rules were buying; the light
  theme's slate therefore takes white ink, and that's accepted rather than worked around.
- **A colour VALUE is a palette key OR an authored `#rrggbb`.** `n.color` (and `effectiveColor`'s
  result) is `''` (inherit), `'none'`, a key, or a custom hex from the colour popover's spectrum
  chip — and **nothing branches on which**, because three resolvers in `main.ts` absorb it:
  `colorFill` (the hex JS tints with — edges, `--frame-stroke`; `null` for none/inherit, which every
  caller already falls back to `--edge` for), `colorClass` (`c-<key>`, or `c-custom` — a hex can't be
  a class name) and `colorVars`/`applyColorVars` (that node's `--card`/`--ink`/`--scrim` written
  inline, since the set of custom colours is open-ended and only a class can carry pre-computed
  ones). Use them at **every** site that turns a colour into a class or a tint — the class sites are
  `paintNode`, `queryItemHTML`, the outline row + its move-picker dot, and the branch card (×2) —
  and never build `c-${color}` or `var(--pal-${color})` by hand again. `applyColorVars` REMOVES the
  triple for a palette key, which is the half that's easy to miss: an inline custom property beats
  any selector, so a card recoloured from custom back to `blue` would otherwise keep the old hexes.
  On disk a custom colour is written **quoted** (`color: "#ff8800"`) and unquoted on read — a bare
  `#rrggbb` is a comment to every real YAML parser, Obsidian included.
  The picker itself is a native `<input type="color">` wrapped in its `<label class="swatch custom">`
  (`features/properties.ts`) — the one form that opens the system colour sheet from a single tap on
  every platform *including iOS*, where there's no `EyeDropper` and `showPicker()` isn't dependable;
  it's `opacity:0` over the chip so the round-bubble look survives (`display:none` would make it
  unreachable on iOS). It streams `input` while the user drags and fires `change` once on commit, so
  the preview paints live with no history entry and the commit rewinds to the pre-drag colours before
  calling `record` — `record` snapshots when it's called, which by then is too late. The float bar
  exempts this chip from its close-on-swatch-click, or the row would vanish mid-pick.
- **Recently-used custom colours** (`features/color-recents.ts`) have TWO sources, exactly like the
  emoji tag picker's recents: the MRU in `localStorage` (`corkboard.colorMru`, cap 8) *plus* every
  distinct custom colour in the open map, derived fresh from `state.nodes`. The second is what saves
  the first from being useless on a device that has never picked one (a fresh browser, the same map on
  the iPad, a `.zip` import), and it self-prunes — recolour the last card away from a shade and it
  stops being offered, with no cache to invalidate. They're a UI convenience, NOT vault data: no
  frontmatter key, no map-level palette. Three things to keep right:
  - **Remember on COMMIT only** (`setColor`, not `applyColor`) — `applyColor` also runs per `input`
    event during a live drag, which would bury the real picks under a drag's worth of intermediates.
    `renderRecents` is likewise called from `setColor`/`sync` but never from `markSwatch`, which the
    live drag *does* call: the derived source reads `n.color`, so a chip would flicker per pointer move.
  - **All chips stay siblings in ONE `.swatches` container**, with a full-width `.swatch-break` forcing
    the row split — that's what keeps the delegated click handler, `markSwatch`'s single
    `querySelectorAll` and the float bar's `.swatch.active` lookup covering both rows.
  - **`#fbColorPop` opts out of `.fb-pop`'s shared height** (the pin that keeps every popover the same
    height as the bar) and its row takes an explicit width, since `.swatch-break`'s `100%` basis needs
    a definite width to resolve against. That width is also what finally makes a narrow window *wrap*
    the palette row instead of running it off the screen edge.
  - Marking: a recent chip rings when it carries the active colour, and the picker chip only ADOPTS
    the colour when no recent chip has it (aged out of the cap, or hand-authored in a note). It can't
    just stop adopting — `.swatch.active` is what `markColorTrigger` mirrors, so nothing ringed would
    leave the float-bar trigger showing the inherit stripes, i.e. reading as "no colour".
