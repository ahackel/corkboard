# Architecture notes

The long form of [CLAUDE.md](../CLAUDE.md): why each invariant holds and what breaks when it doesn't.
CLAUDE.md is the index and stays under 100 lines; detail belongs here. Topics are findable by their
**bolded lead sentence** — CLAUDE.md's pointers quote them. Build commands and module layout live in
CLAUDE.md and are not repeated. Symbol names are the contract; grep for them.

## Identity, titles, frontmatter

**One `.md` file per node; the file's PATH is the node's identity** — it is what `mm_parent` points at and
what the hash encodes. No database, no sidecar. In-memory `id`s are minted fresh on every load; never
persist them.

**A node's TITLE is the leading `# ` line of its body, and nothing else is** (`splitHeading`/`joinHeading`,
`utils/frontmatter.ts` — exact inverses, so a round-trip changes nothing). Not a frontmatter key, not the
filename. Three things follow:

- **Two cards may share a title.** The filename is a derived SLUG that takes a ` 2` suffix to stay unique on
  disk (`desiredFileFor`, `data/persistence.ts`); nothing reads the title back off it, so the suffix never
  shows. Duplicate titles therefore need no `title:` key, and `# Notes` is what a Markdown author writes
  anyway — it reads correctly in Obsidian.
- **No heading means the card is UNTITLED** — only its text, no title row (`no-title`, `styles.css`). Hence
  the test is `#{1,6}` and nothing else. `firstLineLabel` (same file) additionally strips bullets, quotes and
  list numbers, which is right when minting a name for something unnamed (an untitled card's slug, the
  text-drag ghost's caption) and wrong here: a note beginning `- milk` is a list, not a card titled "milk".
- **A slug is minted ONCE and never re-derived.** A card is one text field whose first line is edited
  constantly, so re-deriving would rename the file — and rewrite every child's `mm_parent` — on ordinary
  edits, and would mass-rename a vault of heading-less notes on first open. A stale slug costs nothing: an
  untitled card has no name to be wrong about.

**A body-less note is MIGRATED on load, once** (`loadFromDir`): no `# ` heading *and* an empty body means
the title used to be the filename and nothing in the file says so any more, so the stem becomes the title
and the note is marked dirty; the next save writes the `# Heading` it should have had and it never fires
again (idempotent). The filename doesn't change, so no `mm_parent` is rewritten. Only when the body is
EMPTY — a note WITH text and no heading is a legitimately untitled card. **The word "Untitled" should be
unreachable**, and three things keep it so: this migration, `nodeLabel`'s filename fallback, and
`endBodyEdit` DISCARDING a brand-new card committed with nothing typed in it (emptying an EXISTING card is
an ordinary edit and keeps everything).

**Where a node's name is SHOWN rather than edited, use `nodeLabel`** (`utils/model.ts`): title, else first
line, else the filename stem (`fileStem` — where the title lived before this format), else "Untitled". A
blank row in the outline, in search or on a folder tab is never right, so every display site goes through
it. `disambiguatedLabel` appends the parent for FLAT lists only (search hits, a query card's results); the
outline's indentation already says where a row sits. On the canvas only a CONTAINER falls back to it: a card
showing nothing is the point, but a frame's tab is the only thing you can grab the box by.

**`desiredFileFor`'s collision test is case-INSENSITIVE**, and must stay that way: macOS and Windows collide
`Notes.md` with `notes.md`, so an exact test would hand two nodes "their own" filename and let the second
write eat the first.

**Edges are derived, never stored.** A node's parent is `mm_parent` (the parent note's relative path); the
tree and every edge is computed from it.

**Layout lives in frontmatter as `mm_*` keys:** `mm_parent`, `mm_position_x`/`_y` (relative to the parent,
world origin for a root — see `commitRel`), `mm_side`, `mm_collapsed`, `mm_type`, `mm_layout`, `mm_w`/`mm_h`,
plus the card flags `mm_locked`, `mm_done`, `mm_checklist`, `mm_query`. Serialization rewrites **only**
app-owned keys (`tags`, `color`, `mm_*`) and preserves every other frontmatter field and the body verbatim —
keep that property when touching `parseFM`/`fmSet`/`fmRemove`.

**A node's KIND is `mm_type`; its child ARRANGEMENT is `mm_layout`** — two axes, both resolved by
`foldTypeLayout`, which also folds legacy spellings so old vaults keep loading. Kinds: `card` (default,
omitted), `frame`, `stack`, `image`, `annotation`, `query`. Only card and frame carry a layout (card:
`inherit`/`free`/`line`/`fan`; frame: `free`/`horizontal`/`vertical`/`tabs`); the rest never write
`mm_layout`. The pickers in `features/float-bar.ts` are driven by `NODE_TYPES` + `LAYOUTS_BY_TYPE`; a kind
with an empty layout set hides the layout trigger entirely.

## Frames

**A `frame`'s BOUNDS include its title tab.** The title renders as a folder tab above the box's top-left
corner (`.node.frame > .title-row`, absolutely positioned) and `n.x/n.y/w/h` cover it: `n.y` is the **tab's**
top edge, the box element paints `FRAME_TAB_DROP` (= `FRAME_TAB_H - 1`, the tab less its 1px overlap into
the border) lower, and its inline height is `n.h` minus that drop. The tab therefore sits at a fixed offset
from `n.y` in **both** collapse states — a folded frame is nothing but that tab (`.frame-folded`,
`isFrameFold`, rounded all round, `nodeH` = `FRAME_TAB_H`, width measured) — so folding never moves the
title. `FRAME_TAB_H` is **40px**, a normal card's padding and title metric, and it must equal what the CSS
renders, so the tab's `padding`/`font-size`/`line-height` are pinned in `styles.css` rather than inherited
from `.node .title`.

**A frame is an outline and a label; the ONE thing that FILLS is a DOCKED TAB** — and outline and fill trade
places between the two tab states. The OPEN tab (`.tab-active`) is outlined *and* filled solid in
`--frame-stroke`: the sheet at the front of the folder, so box → tab reads as one outlined shape. An INACTIVE
tab (`.frame-folded.docked:not(.tab-active)`) is fill only, at 62%, with NO border — a sheet tucked behind
that front (which is literally where it paints), so the canvas shows through and no rim draws three shapes
where there is one folder. Semitransparent fill, not `opacity`, which would fade the title too. Everything
that is NOT a docked tab is a 2px outline in `--frame-stroke` over nothing: an expanded frame's tab, a folded
frame, a folded group's pill. Four knock-ons:

- **Every tab keeps the SAME BOX, and `FRAME_TAB_H` is spent three ways.** Widths are MEASURED off the
  element (`nodeW`) and `nodeH` just asserts `FRAME_TAB_H`, so any state spending the 40px differently would
  slide every tab along the strip when you switched which was open. `box-sizing` is `border-box` and nothing
  sets a height, so `padding` + `border` + the 20px line must total 40: `8px/2px` for a pill; a docked tab
  drops the bottom border (that edge meets the box) and pays it back as `padding-bottom:10px`; an inactive
  one drops the border entirely and pays it back on BOTH axes (`padding:10px 12px` — the horizontal half is
  easy to forget, and it's 4px of drift per click). The active tab fills *behind* its border rather than
  dropping it (both `--frame-stroke`, so it rasterizes as one shape) for the same no-reflow reason. Change
  one, change the others. (2px, not the box's 4px: a 4px rim eats most of the label at this size.) The
  selection ring's `inset` pays for that border too — `-4px` on a bordered tab (an absolutely positioned
  child resolves against the PADDING box), `-2px` on a borderless inactive one.
- **A title with no fill under it is inked against what's BEHIND the frame** (`--tab-ink` ← `behindFill`,
  written by `paintNode` on every frame), not against the frame's own colour: `var(--ink)` answers "what
  reads on this fill", the wrong question once the fill is gone. `behindFill` walks out through the
  containers that actually paint one (authorship-tested like `canvasFill`, since `.c-none` is transparent),
  stops at the open frame, and falls back to canvas → map colour → `THEME_BG`. A DOCKED tab has a fill of its
  own, so its title goes back to `var(--ink)`; what still reads `--tab-ink` there is its LOCK BADGE, which
  hangs 8px *outside* the tab — which is why `behindFill` starts a docked tab's walk ABOVE its group.
- **`isFrame` means an EXPANDED frame** (`view/layout.ts` tests `!collapsed`), and so, through `isContainer`,
  does every question built on it. Both rules above must reach the FOLDED half too, which is why `paintNode`
  writes `--tab-ink` off the raw `n.type === 'frame'` and `inFrame` bails on `isFrameFold(n)` beside
  `isContainer(n)`. Get the second wrong and a folded frame falls through to the plain-card branch and takes
  the `.frame-child` tint — whose `(0,3,0)` selector out-specifies `.node.frame-folded`'s own
  `background:none`, so the pill meant to read as a bare outline wears a washed-out fill. (A docked tab
  escapes that by accident, its own fill rule being `(0,4,0)` — don't lean on it.)
- **A folded group's outline is its OPEN TAB's colour**, which is why `effectiveColor` redirects a tabs frame
  to `activeTab` unconditionally rather than only while expanded: the pill already wears that tab's title
  (`foldedTab`), so anything else would show two identities at once. The colour picker on a folded group
  still writes the GROUP (`actionTarget` doesn't redirect while folded), which then shows only when the open
  tab inherits — exactly as on an expanded one.
- **Only a TAB GROUP squares its top-left corner** (`.node.frame.tabs.has-tabs`, mirrored onto the content
  wrapper by `frameContentEl`), so a tab's straight left side meets the box flush. An untabbed frame is
  rounded all round like every other box.

Two more consequences: the tab must stay a single ellipsised line (a wrapping one would make the box's
position depend on a live measurement — hence the hover tooltip in `paintNode`), and the vertical projection
of a hosted child into its host goes through `frameInsetY` rather than a bare `FRAME_BORDER` —
`frameInterior`, `place`, `frameContentEl` and `followEdges` share it (the X axis has no such helper), with
`elTop` the one place that applies the drop.

**Anything that writes a node's `left`/`top` must go through `placeSelf` + `elTop`**, not a bare `place()` —
that is the pair `paintNode`'s final branch uses, and the relayout ANIMATION (`placeNodeEl`/`setNodeElXY`)
writes left/top too, since interpolating them IS the animation. Skipping `elTop` parks a frame's box at its
bounds top instead of one tab lower; because the box paints after the tab strip (tree order, see
`tabStripEl`), a tab group then draws a big empty box over its own tabs for the transition. Skipping
`placeSelf` re-parents a docked tab's label out of its group's strip for the same duration.

**A container's two side wrappers are LIFECYCLE-managed, not just created:** `frameContentEl` exists iff
`hostsContent(n)` (an expanded frame box, an expanded stack, or an OPEN docked tab) and `tabStripEl` iff the
node is an expanded tabs group — `paintNode` drops each the moment that stops holding. Being HIDDEN counts
as holding nothing (`hostsContent` is false for it), which lets the whole lifecycle be ONE drop placed ahead
of `paintNode`'s `isHidden` early return rather than repeated inside it: folding a group hides the open tab
whose wrapper would otherwise survive. Both are created lazily, so a fold/reopen round-trips through the same
code; a folded container's children ride along detached and are re-placed by `place()` when it opens. Skip
the drop and a fold strands an empty `overflow:hidden` div at the box's old size (same for a frame retyped to
a card, or a stack demoted to a row inside another stack).

## Stacks

**A `stack` is an OUTLINER**, and the second container kind besides `frame`. It renders its whole subtree as
one indented, full-width column inside a box that is **width-resizable** (`n.w`, defaulting to `STACK_W` =
`NODE_W`) and auto-fitted in height, so **every descendant's own layout is ignored** and a stack nested in a
stack is demoted to a plain row (`insideStack`). Its `h` is derived by the layout pass and never persisted
(`isBoxType` excludes it from `mm_h`); its `w` is authored like any other kind's. Dropping into one is
resolved on two axes by `stackDropTarget`: vertical position picks the GAP between rows, horizontal position
picks the DEPTH there — so a straight drag only re-slots and nesting takes a deliberate sideways nudge.
(`mm_layout: stack`, its brief spelling as a card layout, still migrates.) Three things to know:

- A row's measured height depends on the width it renders at (text re-wraps), so `prepRow` paints a row
  **before** measuring it; and a container's box size is only known *after* `applyLayouts`, so anything
  painting before laying out must paint again (see `withLayoutAnimation`).
- A row's width is **derived, not stored** (`stackRowW`: the stack's width, less border/padding, less one
  `STACK_INDENT` per depth) — deliberately, so it can't collide with the authored `n.w` a card carries in
  from outside. Drop a 400px card in and it renders as a stretched row while keeping its 400 for when it
  comes back out.
- An EMPTY stack still owes itself an `h`, and it can't be a constant: unlike a frame's single-line tab a
  stack's title WRAPS, so it must be measured (`sizeEmptyStack`, which paints then measures; its height is
  the zero-row reduction of the `node.h` line closing the stack branch — keep the two in step). Both empty
  paths call it. `layoutSubtree` returns early for a childless node, so that early return has to size a stack
  on the way out; without it a stack keeps `nodeH`'s `STACK_HEADER + STACK_PAD` fallback and a two-line title
  spills out of the box.

## Tab groups

**A frame with `mm_layout: tabs` is a TAB GROUP:** its child *frames* aren't content, they're TABS. Their
title tabs flow along its top band (`tabStripRect`/`tabSlots`, DOM wrapper `tabStripEl`) and whichever tab is
OPEN borrows the whole box for its children — the group owns the geometry (x/y/w/h, border, resize handles),
a tab owns only its contents and its tint. Zero new frontmatter keys: docking is plain `mm_parent`, strip
order is `mm_position_x` (`kidsByPosition` sorts tabs by x), open/closed is `mm_collapsed`.

- **A docked tab's bounds ARE its tab rect** — same render path as a folded frame (`isFrameFold` covers both,
  `isFrameBox` excludes it); open vs closed differs only in `mm_collapsed` (which already hides its contents
  via `isHidden`) plus a CSS class.
- **Its contents live in the box its group lent it**, which is what `containerBox` spells — the single
  indirection shared by `frameInterior`, `centreInFrame`, `frameContentTop`, the flow layout and
  `dropLanding`, so none of them needs to know whether the frame is docked **or OPEN** (whose box is the
  viewport — the scope branch comes FIRST there, or an open tab would keep the interior its group lent it). A
  group with tabs shows no tab of its own (`.tabs.has-tabs`): two docked frames must read as two tabs, not
  three.
- **At most one tab is open.** `normalizeTabs` (a pre-pass in `applyLayouts`) repairs it,
  `activateTab`/`openTabFlags` perform it, and every collapse-family path funnels through them —
  `toggleCollapse` on a tab OPENS it, `focusNode` opens a closed tab rather than expanding it. Opening is the
  single thing a LOCK doesn't forbid (it's how you look at the box, not a change to it), so a locked tab stays
  pressable — `dragPointerDown`'s `hasLockedAncestor` bail exempts docked tabs — while moving it is refused.
  Its lock badge hangs 8px outside the tab, which is what `TAB_STRIP_PAD` leaves room for.
- **The strip's tabs must not carry a `z-index`.** `.tab-strip` deliberately has none, so plain tree order
  decides between a tab and the box (`tabStripEl` keeps the strip right BEFORE the box) — which tucks an
  inactive tab *behind* the box like a sheet behind a folder's front, letting the box's border and selection
  ring run unbroken across its top. But a tab is a `.node`, and `.node { z-index:2 }` was quietly overriding
  that and chopping the ring into pieces, so `.frame-folded.docked` resets it to `auto`; only `.tab-active`
  takes one (5), keeping the OPEN tab in front where its three-sided ring joins the box.
- **A group and its open tab carry ONE fold button, and it's on the tab** — the title you can see. `chipFace`
  gives the open tab the `'fold'` face and the click handler redirects to `toggleCollapse(group)`; the group
  shows nothing while open and takes the `'count'` face once folded, when that `+N` is the only way back. A
  CLOSED tab shows neither. Since the two ring as one shape, `.sel-join` reveals the chip as well as `.sel`.
- **A group holds no content of its own**, so anything added "to the group" goes to the open tab: dropped
  cards, `addChild`/`createSibling`, paste (`contentParent`). It has no COLOUR of its own either —
  `effectiveColor` starts the walk at the open tab, so the box (border, incoming edge, outline swatch) is
  tinted by whichever tab is showing, which is also why `dockFrames` doesn't copy the target's colour onto the
  group. A colour authored on the group is *not* an override: the walk continues from the tab THROUGH the
  group, so it stands in for any tab that inherits.
- **A group doesn't exist from the user's side** — there are just tabs, one of them open. User-facing actions
  on a selected group land on the OPEN TAB via `actionTarget`: colour + checklist, rename (`startInlineEdit`,
  the single funnel for F2 / ⋯ / the outline) and deletion (after which `normalizeTabs` promotes the next tab
  and `dissolveEmptyTabGroups` takes the box away with the last one). The float bar centres horizontally on
  the LABEL, not the box (`labelRect`) — a frame's box can be many times wider than its title. An open group
  can't even BE the selection: `selTarget` maps it to its open tab in all three entry points
  (`selectNode`/`setSelectionSet`/`toggleSel`), so clicking the box selects the TAB and the float bar shows
  that tab's kind/layout/colour. What the box keeps is what it visibly owns, moving and resizing, and both had
  to stop asking `state.sel`: `dragPointerDown`'s marquee bail takes `selJoin(n)` as "selected" too (else the
  box would be unmovable), while the resize handles are plain hit-zones. `navArrow`'s `←` steps out of a
  docked tab to the GROUP's parent for the same reason — landing on a group would bounce back to the tab and
  read as a dead key.
- **Tabs are made and unmade by DRAGGING only** (dock a title onto a tab; drag the last tab out and the empty
  box goes with it). `mm_layout: tabs` is bookkeeping the user never picks: `LAYOUTS_BY_TYPE.frame` has no
  tabs chip, and `markChips` hides the whole layout row for any selection holding a tabs frame — a group has
  no arrangement of its own, and a click there would silently dissolve it. That leaves `setType` as
  `undockAllTabs`'s one caller.
- **A folded group is the one that stays selectable** (a lone pill with no tab on screen, so nothing else
  could move or unfold it) — the only place its kind picker and its lock are reachable, and where deleting it
  takes the whole group down instead of promoting the next tab. **Its own title is never on the canvas**,
  folded or not (only in the outline, in search, and as its filename): folded, the pill shows the OPEN TAB's
  title (`foldedTab`) with a folder icon in front (`FOLDER_SVG`, revealed by `.tabs-fold`), so the text
  doesn't change under the fold and the icon is what tells it from a folded plain frame. Two knock-ons:
  `startInlineEdit` on a folded group UNFOLDS it first and then redirects (`actionTarget` only redirects while
  open, and an editor can't open on a `display:none` tab), and `toggleCollapse`'s status line names the open
  tab both ways round.

Dock, undock and re-slot all re-anchor the frame's contents through ONE formula (`reanchorContents`): where
they sat before the gesture (`interiorAtHome` — the lent box if it was already a tab, else its own box at its
pre-drag position), where they sit now, minus the drag delta its cards rode along with the label. Drop that
last term and re-slotting a tab — a gesture that doesn't change the box at all — leaves its content offset
sideways. A docked frame's own `mm_w`/`mm_h` are never touched, which lets it come back out at the size it
went in at. A group left with no children dissolves. What may become a tab is `canBeTab`: a frame, or a plain
CARD, which `dockFrames` turns into a frame on the way in (`asFrame`). Other kinds fall through to the
ordinary drop and land in the box as content — an annotation holds nothing, and a stack/image/query is a box
whose own shape IS the point.

## Open frames (scope)

**A frame can be OPENED, and then the canvas IS its interior** (`nav/scope.ts` for the model,
`openFrame`/`exitScope`/`goToScopeDepth` in `main.ts` for the actions, `features/breadcrumbs.ts` for the
path). While one is open, nothing but its contents is on the canvas, its own box/border/tab are not drawn,
its interior is the whole viewport, and the crumb bar is the way back out. Nesting is allowed. Distinct from
`focusNode`, which frames a card WITHIN the map; this replaces what the map is for as long as you're inside.

- **The scope is a second TERM in `isHidden`, not a second predicate** — one ancestor walk answers both "is a
  parent folded" and "is this outside the frame I'm in". That scopes the paint, the camera, the edges, the
  marquee, drag's hit-tests, the layout pass and the float bar in ONE edit. The scope root counts as outside
  its own scope, and *that* is why its chrome isn't painted: no per-kind rule, no CSS.
- **Nothing writes through that gate, and `applyLayouts` confines itself to the open frame.** A fold is
  persisted `mm_collapsed`, a scope is ephemeral, so the scope must never reach disk. The only mover keyed on
  `isHidden` is `layoutSubtree`, and while a frame is open `applyLayouts` runs it on the scope root ALONE —
  that single line is what stops opening a frame from dirtying a file outside it.
- **An open frame's children are FREE, whatever layout it carries.** `frameFlow` returns null for the scope
  root (`effectiveLayout` already resolves a frame to `free`), so a `horizontal`/`vertical` frame stops
  packing its contents into rows while you're inside: being in a frame should feel like being on the canvas.
  Leaving hands the flow back, so an arrangement made inside a flow frame isn't kept — as a flow frame's
  positions were never the user's to keep. Consequence: opening and leaving move NOTHING, so a visit writes
  nothing to disk whatever layout the frame has.
- **The box becomes the VIEWPORT through `containerBox`/`frameInterior`**, as a DERIVED override. Hard
  invariant: the frame's own `n.w`/`n.h` are neither read there nor written, which lets it come back out at
  its authored size. `frameInterior` needs the guard too (a non-docked frame doesn't route through
  `containerBox`), and `frameContentTop` needs it because an open frame draws no tab to drop below — fixed
  there and NOT by making `isFrameBox` false for it, which feeds `nodeH` and would measure a `display:none`
  element and report a 64px frame. What still READS that rect is where a DROP lands: `dropLanding` clamps into
  `containerBox`, so without the override a card dragged across the open canvas would snap back into the
  frame's small authored box.
- **That rect is a SNAPSHOT at k = 1, refreshed only on a window resize** (`scopeRect`/`refreshScopeRect`). At
  k = 1 — the app's canonical 1 world px = 1 screen px — rather than the live zoom, because opening then fits
  the camera, which would make a live reading circular; a snapshot rather than a live rect so it can't change
  under a pan. `bottomInset()` is excluded (it tracks the SELECTION via the docked float bar, so folding it in
  would move the rect on every click), as is the crumb bar, floating chrome like `#toolbar`. It's anchored at
  the frame's own content origin, so the coordinates its contents already have stay meaningful.
- **Double-click is the way IN and the way OUT.** A frame's interior opens it; the empty canvas — which, once
  you're inside, is that same interior — leaves it (`features/gestures.ts`). At the top level there's nowhere
  to leave to, so the canvas keeps its "new card here". The crumb path and `↓` are the other ways out.
- **The path is ONE pill, and the map name is its first segment** (`features/breadcrumbs.ts` + `#homeBar`) —
  `#toolbar`'s pattern, one `--panel` capsule of borderless items, so going into a frame ADDS segments rather
  than swapping loose text for chrome. Segments carry no folder glyph (the `›` separators already say it's a
  path) and the CURRENT one is inert. A deep path folds its middle into one `…` menu — the only thing that
  keeps it clear of the CENTRED `#toolbar`, since capping the pill's width can't (the separators are
  `flex:none` and simply overflow it).
- **The CANVAS wears the open frame's fill** (`syncCanvasBackground` → `--canvas-bg` on `#stage`, under
  `#grid`; `<body>`'s `--bg` is untouched so the theme is). Same resolver the box used — `effectiveColor` →
  `colorFill` — so the canvas can't disagree with the colour the box was showing, transitioned over
  `animateReflow`'s 320ms so going in reads as the canvas taking the colour rather than a cut — **except when
  the scope came from the URL** (`withoutScopeFade` → `body.scope-instant`, killing the transition for two
  frames): on a reload there's nothing to transition FROM, so the fade reads as flashing the wrong background,
  and on a back/forward step the camera and selection jump too. Only when the colour is **authored** somewhere
  up the chain (`hasAuthoredColor`): `effectiveColor` falls back to the theme's neutral card fill for a frame
  nobody coloured, and painting the whole canvas *that* is a lie, and in the light theme a near-white that
  swallows the chrome floating on it. Authorship, not the hex — a frame explicitly coloured white still tints.
- **At the TOP level that same variable carries the MAP's own colour** — `state.canvasColor`, per-map in
  `settings.json` beside the grid, so it travels with the vault rather than the browser. One resolver answers
  both, `canvasFill`, off `canvasOwner`: the open frame's `actionTarget`, or `null` for "the map". The
  `hasAuthoredColor` test applies only to the frame half — `canvasColor` is authored by definition, and `''`
  means the theme's background.
- **The canvas-colour BUTTON edits whichever of those two you're standing on** (`#canvasColorBtn`, one slot
  left of `#gridSizeBtn`; `features/canvas-color.ts`). At the top level it writes `state.canvasColor`; inside
  an open frame it writes that FRAME's `n.color` — the same field the float bar would write if the frame were
  selected, so nothing new exists for the case. It reads `canvasOwner` too, so the chip on its face shows the
  value it would overwrite. Four things to respect: the chips are `properties.ts`'s row, not a copy
  (`swatchRowHTML`/`markSwatchRow`/`renderRecentChips` were split out of `createProperties` for exactly this —
  what can't be shared is that factory itself, being defined over node ids); the FIRST chip is the only
  difference (`FirstChip` — a card inherits, so it gets the striped chip plus an explicit `none`; the map's
  canvas has no parent, so it gets ONE "theme default" chip and no `none`, which there would mean the same
  thing twice); both halves are undoable in the one timeline (a frame is an ordinary `record`, the map's colour
  goes through `touchCanvas`/`commitStep` and `Step`'s optional `canvas` field, as `state.strokes` already
  does); and the GRID INK is re-derived from whatever fill is behind it (`--grid-pat` on `#stage`, which
  `#grid` declares `--grid-ink` from — the theme's recipe with the canvas fill standing in for `--grid` and
  `inkFor(fill)` for `--text`, so an arbitrary picked colour needs no special case; without it a strong canvas
  colour either swallows the grid or turns it harsh).
- **`hostFrame` and `containerHost` are two different questions.** `hostFrame` is a DOM fact — whose wrapper
  is my element inside — and it stops at the scope root, which hosts nothing. `containerHost` is a TONE fact —
  whose fill am I sitting on — and the open frame governs that all the more now the canvas is painted its
  colour. `inStack`/`inFrame` (the `.stack-child`/`.frame-child` steps) must use `containerHost`, or the cards
  in an open frame lose their step and vanish into a canvas painted the very colour they inherit.
- **`hostFrame` stopping at the scope root** is what makes "the box isn't there" true of the DOM and not only
  of the paint: its children are placed straight under `#world`, unclipped. The `.frame-content` wrapper is
  dropped by the existing ONE drop in `paintNode` (it's `isHidden`, so `hostsContent` goes false), and
  `edges.ts` shares the walk so connectors unclip in step. The `hostFrameId` cache must be cleared on every
  scope change, or elements keep being placed into a wrapper that's about to go.
- **Leaving GROWS a free frame to hold what you put in it** (`fitFrameToContent`, the same one ⇧A runs), and
  only when something really sticks out: inside, the whole viewport was fair game, so a card can end up outside
  the box it goes back to being, where `overflow:hidden` would clip it into invisibility. FREE frames only, and
  that's load-bearing — a flow frame re-wraps into its own box in the `applyLayouts` that FOLLOWS this, so
  measuring here would see a row about to fold itself up and widen the box to fit it, creeping wider on every
  visit.
- **The stack IS the crumb path** (`openPathTo`), not just what you clicked through, so opening a deep frame
  from the ⋯ menu still reads `Map › A › B › C`. Levels you really stepped through remember their camera and
  selection, so leaving one glides back to it; levels rebuilt from a URL don't (their ids are gone) and re-fit
  instead. The stack is session-only; the hash carries only the innermost level.
- **Opening is NAVIGATION, so it isn't undoable** — same class as `revealInView`, and it writes no node field.
  The two things around it that DO are recorded separately: unfolding a collapsed frame on the way in, and the
  grow-to-fit on the way out, so ⌘Z re-folds or un-grows without teleporting you between scopes. Allowed in
  read-only and on a LOCKED frame (`activateTab`'s exemption: looking inside the box isn't changing it) —
  though the double-click route still folds in read-only, since `activateNode` short-circuits there, leaving
  `↑` and the ⋯ menu as the ways in.
- **"No parent" means the OPEN FRAME** (`detachParentId`) — for `createNode`, `createDetachedNode`, a paste's
  payload roots, the outline's `makeRoot`, and a card ripped out of a NESTED frame. A real root would land
  outside the scope and vanish. One helper, read at all five.
- **You can't drag a card out of the frame you're in**: `centreInFrame` returns true for the scope root (its
  interior is the whole canvas, so there's nowhere visible to rip to), and one guard keeps the rip preview and
  the commit agreeing. The way out is to leave first, or the outline's map-wide "Move to…" picker — moving a
  card out is a thing you asked for, dragging into nowhere isn't.
- **Search and the outline are scoped; query cards, wikilinks and undo are not.** Search finds what's on the
  canvas, so every hit can be shown and selected, and `sortedRoots` makes the outline's top level the open
  frame's children (which is also what makes dropping a row beside a top row mean "put it here"). The map-wide
  jumps come OUT of as many levels as it takes first (`popScopeFor`), because `isSelectable` refuses an
  out-of-scope id and the step would otherwise look dead.
- **The open frame is never folded, and never missing.** `applyLayouts` repairs the first beside
  `normalizeTabs` (a reload or an undo can re-collapse it, and `layoutSubtree` bails on collapsed — a blank
  canvas being the worst failure here, so `isHidden` checks scope-root identity BEFORE the fold as a third
  layer). `pruneScope` handles the second in the same pass, truncating the stack to what survives; the camera
  half of that recovery lives in `syncScopeChrome`. A reload re-mints every id, so `resolveScopeAfterLoad`
  re-points the stack by FILE before the first layout — deliberately not cleared like the undo history, since a
  background refocus reload must not kick you out of the frame you're working in.
- **Only frames, for now, but the mechanism is kind-agnostic:** `canOpen` is the one kind test — widen it
  there, never at a call site. A stack stays out (an outliner is not a box you stand in), which is why
  `activateNode` keeps `addChildIn` for it. Opening a tab GROUP opens its OPEN TAB and the crumbs skip the
  group. Ink stays visible but is left out of the framing, or opening a frame would zoom back out to take in a
  stroke on the far side of the map.

## Sizing

**`n.w` is always AUTHORED; `n.h` only for the 2D box kinds.** Every kind can be resized horizontally by
dragging its left/right edge, and `n.w` (→ `mm_w`) is that dragged width and nothing else — never a value a
layout pass computed. Two axes' worth of handles come off that split (`ensureResizeHandles`, `main.ts`):

- `frame`/`image`/`query` are **2D boxes** — 8 hit-zones, authoring both `n.w` and `n.h` (→ `mm_h`, gated by
  `isBoxType`). For a **frame** these are its BOUNDS, i.e. they include the title tab: `mm_position_y` is the
  tab's top edge and the box starts `FRAME_TAB_DROP` lower.
- `card`/`annotation`/`stack` are **width-only** — 2 side zones (`EW_DIRS`), and their height is never
  authored, written inline or persisted: a card/annotation measures it from its content (`nodeH` →
  `offsetHeight`) and a stack derives it from its outline. Minimum width is the kind's own natural width, so a
  card only ever gets *wider*; drag back to it and `n.w` is dropped rather than persisting a redundant `mm_w`.
  An annotation is the exception that can also be narrowed — it shrink-wraps its text, so it has no fixed
  natural width, and it's measured with the authored sizing stripped.

Widening a width-only node changes its measured height as text re-wraps, so the resize gesture paints *then*
re-lays-out on every frame (the same paint-before-measure rule as `prepRow`), and any **annotation** attached
to it is latched to the nearer border on each axis at pointerdown and rides that edge — including the bottom
edge, which moves on its own as the card re-wraps.

## Storage and boot

**The app is local-first.** It boots straight onto the canvas with the last map (no start gate) via `boot()`;
`#startScreen` is a home/storage panel opened by the home button (`#homeBtn`) and closable.

**The `store` adapter is the single swappable I/O boundary.** All disk access (`pick`, `openRecent`, `list`,
`write`, `remove`, `watch`) goes through it. `store` is a reassignable `let`; `useStore(s, kind)` switches
backend and records `kind` in `localStorage` (`LAST_STORE_KEY`). Three adapters, one interface (`satisfies
Store` / `DeviceStore`):

- `opfsStore` — the local-first default. Origin Private File System (`navigator.storage.getDirectory()` →
  `vault/`), works on every browser incl. iPad. Same handle methods as FSA, so `list`/`write`/`remove` are
  identical; no picker, permission or watcher.
- `idbStore` — the on-device fallback for browsers whose OPFS can't write (Safari < 17.2, no `createWritable`).
  `resolveOnDeviceStore()` picks between it and OPFS once, via `opfsCanWrite()`; nothing else branches on the
  difference.
- `fsaStore` — File System Access API (Chrome/Edge only): a real local folder. `resume(key)` silently reopens
  at boot iff permission is still granted; directory handles persist in IndexedDB (`idbGet`/`idbPut`), the
  recent-folders list in localStorage. `HAS_FSA` gates the "Open folder" UI (`?nofsa` hides it to test the
  iPad-style layout on desktop).

**Boot order (`boot()`):** if the last store was `folder` and `fsaStore.resume()` succeeds → reopen it; else
`openDevice()` (the on-device vault). On-device is per-device — there is no built-in cross-device sync.
**Moving maps:** `.zip` import (`importFiles` → `unzip`, accepts `.zip` or loose `.md`, strips a common top
folder) and export (`exportZip` → `zipBlob`); the inline ZIP reader/writer (store + `deflate-raw` via
`DecompressionStream`) is zero-dependency. Retargeting to an Obsidian vault or a Tauri build means replacing
only the `store` object — don't scatter backend calls elsewhere.

**External-change reload:** `store.watch` fires `reloadFromDisk` on window focus / tab-visible (FSA can't
truly watch files; OPFS's `watch` is a no-op, and the focus listener is shared via `installWatch`). It
re-reads from disk but guards against clobbering in-progress typing/renaming and against re-reading the app's
own recent writes (`state.lastSelfWrite`).

**Help map:** `F1` (and `#helpBtn`) opens `?help` in a new tab (`openHelpTab`). On boot with `?help`,
`openHelp()` switches to a read-only `helpStore` serving the bundle-embedded `help/*.md` notes — a real map
isolated in its own tab, so the user's vault is never touched. Titles carry a leading emoji; the map goes
general→specific from a root welcome card, each branch collapsed so users expand to go deeper. Edit the `.md`
files directly; use backtick code spans rather than raw HTML (`renderBodyHTML` escapes `<…>`), and don't wrap
inline `code` in `**bold**`/`*italic*` — the code span is extracted first, so the emphasis won't pair.

## Interaction

**Touch input:** pan/zoom on the canvas is a unified Pointer-Events gesture layer on `#stage` (one finger
pans, two fingers pinch-zoom + pan); node drag/reparent uses the per-node pointer handlers in `bindNodeDrag`.
`#stage`/`.node` set `touch-action:none`.

**Collapse has FOUR entry points, all funnelling through `toggleCollapse`/`toggleCollapseSelection`:** the
corner chip, `X`, the ⋯ menu, and the `←`/`→` arrow keys — which unlike the other three are DIRECTIONAL
rather than toggles. The **chip** is `.hidden-count`: one `<button>` at the node's top-right with two faces —
folded it reads `+N` (the hidden-descendant count, a bare `+` when only a body is tucked away), expanded it
shows a chevron, and *that* face is revealed only on hover or while SELECTED (the touch story: tap the card,
tap the chip — and every card of a multi-selection carries one, whose click folds them all like `X` and
`←`/`→`, without reducing the selection first).

- **`paintNode`'s `chipFace` is the single thing that decides which face shows.** `styles.css` keys off
  nothing but the `data-chip` it writes (`'count'`/`'fold'`/absent), and *no per-kind rule may hide the
  bubble*: `.node[data-chip="fold"]:hover:not(:has(.node:hover))` out-specifies any plain class selector, so a
  rule like `.node.locked > .hidden-count { display:none }` silently loses on hover. Anything that shouldn't
  offer the button is refused in `chipFace` instead — annotations (an annotation IS its body, so folding
  leaves an empty shell), image/query cards, and **locked** nodes (`toggleCollapse` refuses them, so the
  control would do nothing; their folded *count* still shows, being information rather than a control). A
  frame's/stack's own body is never rendered, so only children make one collapsible.
- **Both faces live in the button permanently** (`nodeEl` bakes the chevron in beside a `.cnt` span) and
  `data-chip` picks which is visible, so `paintNode` never rewrites the chip's `innerHTML` — re-parsing that
  `<svg>` per foldable node per paint is real work, and `paintAll` runs once per animation FRAME for the
  length of a resize drag. Which node the button ACTS on is `chipTarget` (itself, or a docked tab's group),
  read by both `chipFace` and the click handler so the button shown and the node folded can't disagree.
- **The chip lives INSIDE `.title-row`** (hence the `> .title-row >` in every one of its selectors), which
  puts both faces in the same spot in every state — hanging 8px off the TITLE's top-right corner — so folding
  never moves the button: the row is the containing block exactly when it's positioned, i.e. when it's a
  frame's title TAB, so a frame's chip rides its tab instead of sitting `FRAME_TAB_DROP` lower on the box, and
  a folded frame / docked tab (whose label IS the element) needs no special case. Where the row is in flow the
  offsets resolve against the node's own padding box, so a bordered box adds its border back (`.stack` →
  `-12px`).
- The hover rule needs `:not(:has(.node:hover))` because child cards are DOM-nested (a deep hover would
  otherwise light up every ancestor's chip at once), and the chip's `pointerdown` must `stopPropagation` so
  `bindNodeDrag`'s `el`-level handler never turns the click into a select/drag — the touch double-tap counter
  in `features/drag.ts` exempts it (via `NODE_CONTROLS`) for the same reason.

**Double-click / double-tap OPENS a node (`activateNode` in `main.ts`)** — folding moved to the chip, which
freed the gesture for what a double-click means nearly everywhere else. One gesture, dispatched by WHAT WAS
HIT, so it covers every kind without a per-kind entry point: a `.title-row` (a card's title row, a frame's
folder tab, a docked tab's whole label) renames via `startInlineEdit` — the single rename funnel, so the
tab-group/annotation/query redirects, the CONTAINER hand-off and the lock refusal come for free; anything else
on a card edits its note (on a card those two are the same editor with the caret in a different place). A
FRAME's interior OPENS it (`openFrame`); any OTHER container's interior — i.e. a stack, which `canOpen`
refuses — gets a new card THERE (`addChildIn` → `addChild`, which routes a group to its open tab, refuses a
locked parent and reveals a folded one). The same gesture on empty canvas creates a root card (`stage`'s
`dblclick` in `features/gestures.ts`) — **or, while a frame is open, LEAVES it**, since the canvas then IS
that frame's interior. Going in and coming out being one gesture is most of what makes a frame feel like a
folder; making a card inside an open frame is `Space`, `Tab` and the canvas right-click, which all land it in
that frame (`detachParentId`). Four things hold it together:

- **The INNERMOST node owns the gesture, including the ones it declines.** Child cards are DOM-nested, so both
  handlers (`nodeEl`'s `dblclick`, the touch double-tap in `features/drag.ts`) `stopPropagation` BEFORE their
  bails, not after — otherwise a gesture this card refuses bubbles to its host card, which reads it as a
  double-click on itself, opening the HOST's editor and sending the rest of the typing into the parent's note.
  On touch it's worse, since each ancestor keeps its OWN tap counter. A container's children are exempt by
  construction — they live in its sibling `.frame-content` / `.tab-strip` wrapper, not inside its element.
- **`NODE_CONTROLS`** (`main.ts`) is the one list of things that act on a SINGLE click — chip, checkboxes,
  links, `.addnote`, query input, resize handles `.fh`. Both the `dblclick` handler and the touch double-tap
  counter bail on it, or the second click would fire the button AND open the card.
- **A folded node is nothing but its title** (`.node.collapsed .body { display:none }`), so EVERY hit on it
  renames — otherwise a double-click would open an editor inside a hidden `.body`.
- **Read-only keeps the old meaning** (fold/unfold, the one thing the mode allows). The short-circuit sits
  ahead of everything, so a read-only double-click on a frame FOLDS it rather than opening it — `↑` and the ⋯
  menu are the routes in.

**A click now only ever SELECTS.** Don't reintroduce a slow-second-click rename timer: it can only race the
double-click it was invented to lose to.

**MERGING notes and BREAKING them apart are two DRAGS, not two commands** — where Scrivener and Ulysses put
list commands on a multi-selection, a canvas has a place to point at. No menu entry, no shortcut for either;
adding one is a decision, not a gap. Neither writes a new frontmatter key — a merge is a body edit plus a
delete, a break is a body edit plus a create.

- **⌥-drop card(s) onto a card MERGES them into it** (`mergeDrag`/`cardMerge` in `features/drag.ts`,
  `mergeCardsInto` in `crud.ts`). The card you dropped ONTO survives — its id, file, colour, size and flags —
  and each dragged note folds into its body as `## Title` then its text, in selection order. Tags are unioned
  in; their CHILDREN come up onto the target rather than going with them, since merging notes must never take
  a branch with it. `canMerge` is the ONE kind test and answers for both sides: a plain card or an annotation
  (which contributes text and no heading, and takes none either). Every other kind is a box or a leaf whose
  shape is the point. Merging INTO an annotation needs its own line (`kidHome`): an annotation is a LEAF
  (`isLeafType`, it never adopts children), so the swallowed cards' children go to the card that annotation is
  PINNED to, or the top level.
- **⌥ is affordable here because it's the image fold's twin** (`imageMerge`/`foldImageCardsIntoBody`), resolved
  in the same branch chain and previewed with the same `.drop-merge` dashed outline: the modifier's ordinary
  meaning (detach to root) applies when there's nothing valid under the cursor, so nothing was displaced —
  plain drag still reparents, ⇧ clones, ⌘ toggles the selection. The centre/edge zones on a card were already
  spoken for (sibling/child), which is why this needs a modifier at all. One knock-on: `paintDetachPreview` (⌥
  pressed mid-drag) goes through `dragFollow`, so the target's outline appears on the KEYPRESS rather than the
  next mouse jiggle.
- **Dragging a card's selected text OUT of its editor BREAKS it apart** (`features/text-drag.ts` →
  `dropCardText`), after Heptabase's whiteboard gesture: drop it on empty canvas and it becomes a card of its
  own, in a container and it becomes a card THERE, on another card (or an annotation) and it's appended to that
  note. Always a MOVE — the text leaves the source, whose editor is DROPPED rather than ended, since
  `endBodyEdit` would write the editor's stale value back over what was just cut. `TextSource`
  (`{id, start, end}`) is the range, captured at `dragstart` and read back live at the drop (`liveText`), since
  the offsets are into what the EDITOR shows, not into `n.title`/`n.body`. **Dragging a card's NAME out is the
  same gesture and needs no second arm**, the name being the `# ` line inside that very field: `cutCardText`
  re-SPLITS whatever is left, so cutting the heading away just leaves the card untitled.
- **Where the new card belongs is ONE rule read both ways: the box you dropped in governs.** Dropped in a
  container, it's that container's child. Dropped on the open canvas *from a card that lives in a container*,
  it goes to the TOP LEVEL (`detachParentId`) — dropping on the canvas is how a note comes OUT. ("A sibling of
  the source" got this wrong: it parented the card back INSIDE the box, so text dragged out of a stack's row
  put a new ROW in the outline, and out of a frame's card put one where `overflow:hidden` clipped it away.)
  Only a source already on the canvas keeps the sibling reading (slotted right after it, like `createSibling`).
  The "am I in a box" test is `hostFrame`, right precisely because it stops at the scope root: inside an OPEN
  frame there is no box to come out of, so its cards stay siblings. Splitting the dragged lump is `splitHeading`
  itself — a leading `# ` line becomes the new card's title, and without one the card is untitled and the whole
  lump is its body. Shared with `⌘⇧E`.
- **What rides the cursor is a CARD** (`buildGhost` → `setDragImage`, `.node.drag-ghost`), not the browser's
  default snapshot of the dragged LETTERS: a real `.node` captioned with the text's own first line
  (`firstLineLabel` — the WIDE read: any first line makes a caption, where only a `# ` line would make a real
  title), tinted with the SOURCE card's resolved colour, since that's what a sibling would inherit. It must be
  IN the document for the browser to snapshot it during `dragstart`, so it's parked off-screen horizontally
  (`display:none`/`visibility:hidden` snapshot as nothing; moving it off vertically only would keep its width)
  and removed on the next tick — removing it inside the handler can beat the snapshot.
- **It rides the browser's NATIVE text drag** (a textarea selection is draggable for free) rather than the
  pointer machinery in `drag.ts`, which keeps it out of that file's gesture vocabulary — at the cost of being
  desktop-only, leaving `⌘⇧E` (extract to a child) as the way to break a note apart on iPad. A card element
  being `draggable` (the ⌥ card-file export, `features/clipboard.ts`) interacts with it twice. A draggable
  ANCESTOR is decisive about what a drag begun inside it drags, so a selection can never come out of a
  contenteditable while it holds; a `<textarea>` is the exception (a text control holding a selection outranks
  the ancestor), so now that a card is ONE textarea the problem is structurally absent — it survives only for a
  CONTAINER's label editor, still a contenteditable (`ui.titleEdit`), since a frame's `.body` is `display:none`
  and its tab can't host the card field. That same `dragstart` handler also cancels every native drag it doesn't
  own, so it must stand aside for this one: `cardTextDrag` is the shared resolver, and it tests the CARD the
  drag began on, not just "some editor is open", or an editor left open elsewhere would make that card's export
  (or an ⌥ image extract) stand down. The drag DATA is left to the browser; the one drop we don't handle is the
  selection dragged back into its own note, a plain in-textarea move that must stay one (hence `destAt`
  returning null for the source card).

**Arrow keys go IN and OUT, and fold and unfold (`navArrow` in `main.ts`):** `↑` opens the selected frame, `↓`
leaves the open one, `→` unfolds, `←` folds. All four are about DEPTH, in the two senses this map has — which
folder you're standing in, and whether a branch is showing. **Walking siblings and stepping onto a child lost
their keys to that**, deliberately: opening a frame is now the primary way to move around a big map, and
clicking (or the outline, a real tree widget) covers siblings. The keys no longer pan — `↑` re-frames via
`frameBox`, `↓` glides back to a remembered camera, `→`/`←` don't move the camera at all (`revealInView`
survives for its other callers). They were never geometric: a child's side is its own stored `mm_side`, so a fan
branch has children on two sides at once and "left" would stop meaning anything. Two details: `←`/`→` are
DIRECTIONAL rather than toggles (pressing `→` twice can't fold what it just unfolded, and a MIXED selection
lands on one state in a single press), and `←` on an OPEN docked tab folds its GROUP, exactly as its corner chip
does (`chipTarget`). They act on the WHOLE selection via the directional sibling of `toggleCollapseSelection`,
both filtering through one shared foldable-selection helper so the chip, `X` and the arrows can't disagree about
what counts — a keyboard fold has no business reaching fewer cards than a click does. `↑` stays single, since
you can only stand in one frame. Because the directional form skips cards already in the target state, its undo
step covers exactly what it changed. `↓` reads the SCOPE, not the selection, so it still works right after
clicking empty space to deselect — which is exactly when you want to go up; it's silently inert at the top
level, since a status line there would nag on every repeat.

**`⌘A` selects everything ON THE CANVAS** — which, inside an open frame, is that frame's contents and nothing
else. It needs no scope test of its own: `isHidden` already means "on the canvas right now", and
`setSelectionSet` drops whatever isn't selectable. Guarded by `isTypingInField`, since in a field `⌘A` belongs
to the field.

## Colour and zoom

**ONE card palette for both themes.** `body.light` overrides no `--pal-*` value, so a card is the same colour
wherever the map is opened — and therefore has one ink, decided by the colour itself. `refreshPalette` still
re-reads on a theme toggle (a no-op now, kept so a future per-theme colour would work) and still repaints,
because what *does* differ per theme is `effectiveColor`'s fallback for an uncoloured card / an annotation, plus
`c-none`'s ink.

**A card's text colour is DERIVED from its fill, never authored.** The palette hexes are the `--pal-*` custom
properties in `styles.css` (one source of truth, read into JS as `SWATCH_BG`), but the **ink** each demands is
computed: `utils/ink.ts` measures WCAG contrast and `main.ts`'s `deriveInk` injects a `--pal-ink-*` +
`--pal-scrim-*` pair per key into a generated `<style>`. The `.c-*` classes hand those to a card as **`--ink`**
(its text colour) and **`--scrim`** (what an in-place editor paints *behind* that ink). Four rules follow:

- **No rule anywhere may name a colour key to fix its text.** One `color: var(--ink)` per surface that wears a
  `.c-*` class (`.node`, `.query-item`, `.oc-card`, `.ol-row`) covers every colour in both themes — that
  replaced four hand-maintained exception lists that all had to agree, and it's what lets an off-palette colour
  work with no new CSS.
- **`--scrim` is paired with the ink, not fixed.** Every editor backdrop (`.title.editing`, `.body-edit`,
  `.query-input`, `.oc-title:focus`, `.ol-title.editing`) uses it: a hardcoded dark scrim under dark ink is
  unreadable. Same reason the body's marks (`code`, `pre`, `blockquote`, `hr`, image placeholders) tint with
  `color-mix(… var(--ink) …)` instead of a literal white/black.
- **Ink is a property of the CARD, not of the theme** — which is why the ink hexes are fixed and `body.light`
  overrides text nowhere. `c-none` is the one exception, by construction: with no fill there's nothing to
  measure, so it takes `var(--text)` and has its scrim flipped by hand. Ink is computed from a container's *own*
  fill; a stack's `86%`-toward-black step and the `93%`-toward-`--ink` step its rows and a frame's child cards
  take are not re-measured (all stay legible — the stack's darkened fill is thinnest at ~3.2:1 on a bold title).
- **A card inside a container steps one notch off its host's fill** — `.stack-child` for a stack's rows,
  `.frame-child` for the cards in a frame's box (`inStack`/`inFrame`, nearest container ancestor by
  **`containerHost`**, deliberately not `hostFrame`, so an OPEN frame still steps its cards though it hosts no
  elements). A card INHERITS its colour from its ancestors, so one dropped into a coloured container resolves to
  the container's own fill and vanishes into it. The step is `93%` toward that card's own **`--ink`**, not a
  literal `#fff`: `--ink` is by construction the direction that HAS contrast against this fill, and white has
  none on a pale one (the light theme's default card is `#f2f4f7`, whose row came out flat). That the visible
  steps didn't change is structural: `INK_MIN` hands out dark ink only *below* its contrast floor, i.e. on
  exactly the fills too pale for a white step to show, so the two switch over together. Only plain cards take the
  tint (`inFrame` refuses the rest) — a nested container already owns its tone, and an annotation never inherits
  a colour to begin with.

The bias is deliberate: light ink is kept unless its contrast falls below `INK_MIN` (**2.5**) rather than always
taking the higher contrast, and that one number serves both themes. It's pinned low enough that **every palette
colour keeps the ink it had before any of this existed** (the lowest being the dark theme's amber at 2.85), so
dark ink is reserved for fills genuinely too pale for white — the off-palette case this is all for. No single
threshold can also flip the light theme's pale fills, so its slate takes white ink, accepted rather than worked
around.

**A colour VALUE is a palette key OR an authored `#rrggbb`.** `n.color` (and `effectiveColor`'s result) is `''`
(inherit), `'none'`, a key, or a custom hex from the colour popover's spectrum chip — and **nothing branches on
which**, because three resolvers in `main.ts` absorb it: `colorFill` (the hex JS tints with — edges,
`--frame-stroke`; `null` for none/inherit, which every caller already falls back to `--edge` for), `colorClass`
(`c-<key>`, or `c-custom` — a hex can't be a class name) and `colorVars`/`applyColorVars` (that node's
`--card`/`--ink`/`--scrim` written inline, since the set of custom colours is open-ended and only a class can
carry pre-computed ones). Use them at **every** site that turns a colour into a class or a tint — the class
sites are `paintNode`, `queryItemHTML`, the outline row + its move-picker dot, and the branch card (×2) — and
never build `c-${color}` or `var(--pal-${color})` by hand. `applyColorVars` REMOVES the triple for a palette
key, the half that's easy to miss: an inline custom property beats any selector, so a card recoloured from
custom back to `blue` would otherwise keep the old hexes. On disk a custom colour is written **quoted**
(`color: "#ff8800"`) and unquoted on read — a bare `#rrggbb` is a comment to every real YAML parser, Obsidian
included.

The picker is a native `<input type="color">` wrapped in its `<label class="swatch custom">`
(`features/properties.ts`) — the one form that opens the system colour sheet from a single tap on every platform
*including iOS*, where there's no `EyeDropper` and `showPicker()` isn't dependable; it's `opacity:0` over the
chip so the round-bubble look survives (`display:none` would make it unreachable on iOS). It streams `input`
while the user drags and fires `change` once on commit, so the preview paints live with no history entry, and
the commit rewinds to the pre-drag colours before calling `record` — `record` snapshots when it's called, which
by then is too late. The float bar exempts this chip from its close-on-swatch-click, or the row would vanish
mid-pick.

**Recently-used custom colours** (`features/color-recents.ts`) have TWO sources, like the emoji tag picker's
recents: the MRU in `localStorage` (`corkboard.colorMru`, cap 8) *plus* every distinct custom colour in the open
map, derived fresh from `state.nodes`. The second saves the first from being useless on a device that has never
picked one (a fresh browser, the same map on the iPad, a `.zip` import), and it self-prunes — recolour the last
card away from a shade and it stops being offered, with no cache to invalidate. They're a UI convenience, NOT
vault data: no frontmatter key, no map-level palette. Four things to keep right:

- **Remember on COMMIT only** (`setColor`, not `applyColor`) — `applyColor` also runs per `input` event during a
  live drag, which would bury the real picks under a drag's worth of intermediates. `renderRecents` is likewise
  called from `setColor`/`sync` but never from `markSwatch`, which the live drag *does* call: the derived source
  reads `n.color`, so a chip would flicker per pointer move.
- **All chips stay siblings in ONE `.swatches` container**, with a full-width `.swatch-break` forcing the row
  split — that's what keeps the delegated click handler, `markSwatch`'s single `querySelectorAll` and the float
  bar's `.swatch.active` lookup covering both rows.
- **`#fbColorPop` opts out of `.fb-pop`'s shared height** and its row takes an explicit width, since
  `.swatch-break`'s `100%` basis needs a definite width to resolve against. That width is also what makes a
  narrow window *wrap* the palette row instead of running it off the screen edge.
- **Marking:** a recent chip rings when it carries the active colour, and the picker chip only ADOPTS the colour
  when no recent chip has it (aged out of the cap, or hand-authored in a note). It can't just stop adopting —
  `.swatch.active` is what `markColorTrigger` mirrors, so nothing ringed would leave the float-bar trigger
  showing the inherit stripes, i.e. reading as "no colour".

**Below `FAR_ZOOM` (50%, `view/camera.ts`) every overlay badge is dropped** — `applyView` puts `zoom-far` on
`<body>` and `styles.css` hides the fold chip, the lock badge, the emoji tag row and the `.addnote` pen: a few
unreadable pixels each at that scale, times every card on screen. Purely a CSS mode (no node geometry depends on
it, so crossing the line needs no repaint), and the hides need `!important` — those controls are revealed by
`:hover`/`.sel`/`[data-chip]` selectors no plain class can out-specify. Add any new card-corner badge to that
rule. Page CHROME is out of scope and must not be added: `#scopeBar`'s crumbs stay legible at every zoom, since
being zoomed out is when you most need to know which frame you're standing in.

## State and naming

**The mutable `state` (`core/state.ts`) is the MAP:** `nodes` (id → node), `view` (`{x,y,k}`), selection (`selId`
+ `sel` Set), `edgeStyle`, `readOnly`, `canvasColor`, the grid settings, … Every field is either the notes
themselves or something mirrored to disk/localStorage and restored on load. The render pipeline is `paintNode` /
`paintEdges` / `paintAll`; DOM nodes live under `#world`/`#stage`, edges in the `#edges` SVG. The open-frame
scope is deliberately **not** in here (it lives in `nav/scope.ts`): a scope is where you're STANDING, never
reaches frontmatter, is mirrored only into the hash, and its camera stack is session-only.

**The app is called Corkboard; the old "mindmap" name survives in exactly three places on purpose.** Everything
persisted outside the vault is prefixed `corkboard.` (localStorage) or named `corkboard`/`corkboard-vault`
(IndexedDB), and neither kind of name can be renamed in place — so both are carried over ONCE:
`utils/legacy-keys.ts` sweeps the `mindmap.*` keys on import (imported FIRST in `main.ts`, since
`initEdgeStyle`/`setupTheme` read settings while `main.ts`'s own body evaluates), and `openRenamed`
(`utils/idb.ts`) copies a legacy database into the new one on first open, guarded on the new store being EMPTY so
it can run only once and can't overwrite fresher data. What must NOT be renamed: the notes' **`mm_*` frontmatter
keys** — that's the file format, not the product, and a vault has to keep opening in Obsidian and in older
builds. The clipboard marker splits the difference: it WRITES `<!-- corkboard-card: … -->` and READS both
spellings (`features/clipboard.ts`). Use "map"/"board" for the document (`store.name`, the registry, `mm_*`) and
"Corkboard" only for the product.
