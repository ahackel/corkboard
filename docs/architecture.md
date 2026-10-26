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
- **The slug TRACKS the note's text** (`slugStem`/`desiredFileFor`, `data/persistence.ts`). Every save
  re-derives it, so a file always reads as the name the card shows: its `# ` heading, else its first
  line, else — for an image card — its picture. It used to be minted ONCE and left to go stale, on the
  argument that an untitled card has no name to be wrong about. That argument was wrong about the
  ORDINARY card: every card is born empty and the autosave 400ms later names it off nothing, so it got
  `safeName('')` — `Untitled.md`, `Untitled 2.md`, … from the collision suffix — and the text typed a
  second later never reached the filename. A vault filled up with `Untitled 47.md`.
- **Tracking is paid for in renames, and everything holding a path follows one.** A rename rewrites the
  children's `mm_parent` (`saveAll` phase 1, which is why every path must be final before anything is
  serialized) and re-points the inbound PATH-form `[[wikilinks]]` (phase 1b, `retargetWikilinks`, alias
  half kept verbatim). Title-form links need no fixup: re-slugging a file never changes a title.
- **It is not a rename per keystroke.** While any of the four editors holds the note's text the name is
  FROZEN (`ui-state.ts frozenFileNodeId`), so the rename lands once, when the edit session commits —
  never as `M.md`, `Ma.md`, `Mag.md`. That freeze is what makes tracking affordable at all.
- **A collision takes a NUMBER, and the note keeps its name** — `Notes.md`, `Notes 2.md`, both titled
  "Notes". The test is case-INSENSITIVE, since that is how the filesystem collides; `taken()` excludes
  the asking node, so a card already holding `Notes 2.md` keeps it rather than churning every save.
- **Nothing to be named off = keep the name you have.** `stem === 'Untitled'` (safeName's empty-string
  fallback) means no heading, no text, no picture: there is nothing to track, so `desiredFileFor`
  returns the current name. Two things fall out of that one line — a still-empty `Untitled 7.md` doesn't
  renumber as its neighbours come and go, and a card the user CLEARED keeps the slug it was named
  under, which is what `utils/model.ts namelessLabel` leans on when it refuses to show the stem.

**The blank line under a heading is the note's, not the app's** (`titleGap`). Title and body are two
fields where the file is one text, so the split loses exactly one thing: whether `# Title` was followed
by a blank line or by the note itself. `splitHeading` reports it, `MindNode.titleGap` carries it and
`joinHeading` writes it back, which is what makes the pair the exact inverses they claim to be — delete
that line and it stays deleted, through the editor, the save and the next load. It is NOT a frontmatter
key: it's implicit in the file, so nothing new is written to disk. Absent means the spaced default,
which is what the paths that BUILD a note rather than re-read one (a merge, an extract, a paste) get.

**A body-less note is MIGRATED on load, once** (`loadFromDir`): no `# ` heading *and* an empty body means
the title used to be the filename and nothing in the file says so any more, so the stem becomes the title
and the note is marked dirty; the next save writes the `# Heading` it should have had and it never fires
again (idempotent). The filename doesn't change, so no `mm_parent` is rewritten. Only when the body is
EMPTY — a note WITH text and no heading is a legitimately untitled card.

**A note that is blank ON PURPOSE says so, with `mm_blank: true`.** Clearing every character out of an
existing card is an ordinary edit that keeps its file, children and position — but the file it leaves behind
looks exactly like the unmigrated note above, so that migration used to read the card's own filename slug
back as a title and save it as a heading: the name you just deleted, restored on the next load. Nothing else
on disk separates the two cases (`mm_position_x` predates the title-in-body format by ~100 commits, so its
presence proves nothing), hence one flag, written by `serializeMd` only while the note has neither title nor
body and swept away by the stale-`mm_*` pass as soon as anything is typed. `loadFromDir` skips the migration
when it is set. A blank card is meant to be reachable; only a brand-NEW card committed empty is discarded
(`endBodyEdit`).

**Where a node's name is SHOWN rather than edited, use `nodeLabel`** (`utils/model.ts`): title, else first
line, else **`No-title N`**. A blank row in search or on a folder tab is never right, so
every display site goes through it. The last resort used to be the filename stem, and deliberately isn't any
more: a card the user emptied keeps the slug it was named under (`desiredFileFor` renames nothing when
there is nothing to name off), so the stem
is precisely the name that card must no longer be called — and a container nobody ever named is
`Untitled.md` on disk anyway. `N` counts nameless nodes in map order, so it renumbers when one is added or
filled in; that is safe because nothing stores or matches on this string (a `[[wikilink]]` resolves against
`n.title` and the filename, `focusByTitle`). `disambiguatedLabel` appends the parent for FLAT lists only
(search hits). On the canvas only a FRAME falls back to `nodeLabel`: a card showing nothing is the point, but a frame's tab is the
only thing you can grab the box by.

**`desiredFileFor`'s collision test is case-INSENSITIVE**, and must stay that way: macOS and Windows collide
`Notes.md` with `notes.md`, so an exact test would hand two nodes "their own" filename and let the second
write eat the first.

**Hierarchy is `mm_parent`; a LINE is something the user drew.** A node's parent is `mm_parent` (the parent
note's relative path) and the tree is computed from it — a card sits INSIDE the frame that is its parent, so
no line is ever derived from it. Lines live in `board.json` (`BoardEdge`: two card ids written as PATHS, colour, dash, end
caps, label) and are drawn as FigJam's ELBOWS (`view/free-edges.ts` `route` → `polyline`, behind
`edgeGeometry`, the one place the geometry is computed): along the axis the two cards are further apart
on, a line runs straight across where they face each other, else leaves the middle of one side, turns
(rounded, `CORNER_R` 24px, never eating the last `END_STRAIGHT` of an end leg so a cap sits on a straight) halfway across the gap and enters the middle of the other. Overlapping cards get the
plain centre-to-centre line. An end dropped on a PORT is PINNED to that face (`fromPort`/`toPort` in
`board.json` — new keys: the `fromSide`/`toSide` an older build wrote on every edge stay ignored, or every
old line would be pinned to a face nobody chose). A pinned line leaves/enters that face square and is
routed by `pinnedRoute`: a few orthogonal shapes per allowed pair of faces (the middle Z first, then
detours STUB out and round either box), keeping those that cross neither card, shortest + `BEND_COST` per
bend wins. Only faces are stored; the route is re-derived on every paint (docs/PRODUCT.md, principle 2). Two
cards can be joined more than once as long as the ports differ: a draw is a duplicate (and selects the
existing line instead) only when it joins the same two cards through the same ports (`edgeBetween`). You draw one from the four rings on a selected card
onto ANY point of another card; an end handle moves that end. Older boards may carry JUNCTIONS (points
where lines met away from a card) and per-end faces: the faces are ignored, and junctions are flattened
into card-to-card lines on load (`utils/edge-graph.ts flattenJunctions`, tested).

**Layout lives in frontmatter as `mm_*` keys:** `mm_parent`, `mm_position_x`/`_y` (relative to the parent,
world origin for a root — see `commitRel`), `mm_collapsed`, `mm_type`, `mm_w`/`mm_h`, plus the flags
`mm_locked` and `mm_blank` (positions, sizes and collapse now live in `board.json` and are only READ from an
older note). `mm_layout`, `mm_checklist` and `mm_done` belong to cut features: still read where they
mean something on load (a legacy `mm_layout: frame`), dropped on a note's next write. Serialization rewrites **only**
app-owned keys (`tags`, `color`, `mm_*`) and preserves every other frontmatter field and the body verbatim —
keep that property when touching `parseFM`/`fmSet`/`fmRemove`.

**Cards are flat; a FRAME is the only container** (docs/PRODUCT.md). A node's kind is `mm_type`: `card`
(default, omitted) or `frame`, resolved by `foldType`, which folds every retired kind (`stack`, `image`,
`annotation`, `query`) to `card` and a legacy `mm_layout: frame*` to `frame`. A card never has children —
structure inside a thought is written into the note (`- [ ]` tasks tick in place) — and a frame's children
sit wherever they were put: there are no arrangements, no outliner, no checklist mode. Four rules hold it:
- **One drop rule** (`view/layout.ts frameAt`): on release, each dragged root belongs to the INNERMOST
  expanded, unlocked frame its centre is in, else the top level (the open frame while one is open). The
  preview lights that frame (`.drop-target`) and `drag.dropTarget` carries it so `effectiveColor` can preview
  the inherited colour. ⌥ over a plain card is the one exception: a MERGE into its note. Text dragged out of
  an editor and ⌘V land by the same test (paste goes where the POINTER is, not into the selection).
- **Cards can't hold cards, however it's asked** — `holderOf(id)` turns any "create in X" request into X's
  frame (X itself if it is one), and every create/paste path goes through it.
- **A frame GROWS to hold what's put in it** (`growFramesToHold`, `features/float-bar.ts`): after a drop,
  a create, a paste or an edit that leaves a card past its frame's edge, the frame widens outward (never
  shrinks, never moves a side that already clears). A frame clips (`overflow:hidden`), so the alternative is
  a card that is in the frame and out of sight.
- **A card with children on disk is MIGRATED on load** (`data/persistence.ts foldCardsIntoFrames`): it
  becomes a frame holding them (only `mm_type` changes), and each converted frame — plus any frame that was
  drawn as a row inside one — lays its cards out ONCE in a column in their old order (`kidOrder`) and sizes
  itself around them, deepest first. That needs measured heights, so affected nodes are unfolded and painted
  with the scope set aside, then folded back. Every load runs it; a migrated map has nothing left to convert.

**A frame wears only its OWN colour** (`effectiveColor`): an uncoloured one is the neutral white surface.
Inheriting made a frame nested in a blue frame blue, and so invisible. Cards still inherit from the frame
they sit in, in its FULL colour — which reads because the box wears a PALE wash of it (below).

**A frame COLLECTS what it covers** (`settleFrames`, features/drag.ts) — the drop rule run from the frame's
side, the way a FigJam section behaves. After a frame is moved, resized or made (createNode, Group), every
card whose centre is now in it is reparented to it (`frameAt`, so the innermost frame still wins), and every
card of its own whose centre is now outside goes to whatever it is over — a shrink lets go of a card rather
than hiding it under the clip. A FRAME is only collected when its whole box is inside: by its centre alone a
big frame could be swallowed by a small one laid across it. Locked and hidden things stay put. A move or a
create then grows frames around what they took in (`growFramesToHold`); a resize doesn't — the user just
chose that size — but a card it let go of grows the frame it landed in.

## Frames

**A frame looks like a FigJam SECTION: a pale box, its name on a pill ABOVE it.** The box is the frame's
colour washed 68% toward white (`color-mix`, `FRAME_WASH`/`paleFill` in `utils/ink.ts` for the one JS reader,
the open frame's canvas) with a 1px rim a step darker than the colour (`FRAME_BORDER` = 1). The label is a
pill filled with the frame's full colour, so its text takes that colour's own `--ink` like any card.

**A frame's BOUNDS are its box; the label hangs OUTSIDE them.** `n.x/n.y/w/h` are the box, and the pill sits
7px above its top-left corner (`.node.frame > .title-row`, `bottom:calc(100% + 7px)`), growing upward. So
naming, renaming, describing or un-naming a frame never moves the box or anything in it, and nothing in
the geometry (interior, drops, lines, the reading view) has to know about the label. What does: anything
that FITS a box around frames — `subtreeBox` counts `frameLabelH` (the pill's measured height + its gap)
above an expanded labelled frame, so Auto-size, grow-to-hold, Group and the load migration's column leave
a nested frame's name room instead of clipping it. **Frames don't fold** (`canFold` in main.ts — only a
card or image card with a note can): hiding a frame's contents was cut, along with its eye button and the
first-open auto-fold of big maps. A frame saved folded by an older build opens as its box (loadFromDir).

**A frame's note is drawn on its LABEL: the name, and its DESCRIPTION under it.** The `# ` heading is the
name; the rest of the note is the description (`frameDescription`), one muted ellipsised line under the
name (`.frame-desc`). Each stays one line (hence the hover tooltip in `paintNode`). The frame's editor is the
label itself: Enter finishes, ⇧Enter adds a line, and line breaks are kept (read while the editor is still
pre-wrap).

**A frame with nothing written on it shows NO LABEL** (`frameLabelled`) — delete its text and it's an
untitled box, like an untitled FigJam section. Three ways back to writing on it:
- **The toolbar's title button (T)** (`editFrameTitle`): on an untitled frame it seeds `# Frame` and selects
  the word, so typing replaces it and keeps the heading; on a named one it opens the label with the text
  selected. Esc on a seeded name leaves the frame untitled.
- **The RIM.** Double-clicking its border — measured geometrically (`onFrameRim`), since the content
  wrapper is click-through and a hit anywhere inside comes back as the frame's own element — opens its
  text editor, named or not. The band includes the resize zones lying over that border, which is why this
  is the one gesture allowed past the `NODE_CONTROLS` bail — a double-click means nothing on a handle.
- **F2 / Rename** in the menu.
FOLDED, an untitled frame is a bare stub — and the CHIP is what keeps it usable. The row goes invisible
rather than `display:none`: `.hidden-count` lives inside it, and hiding it would leave a nameless frame with
no way to open again. Expanded, that invisible row collapses onto the BOX's top edge, so the chip hangs off
the corner the way a card's does. The stub asserts its 40px (`min-height`, `--frame-tab-h`). While its editor
is open the row is revealed regardless (`ui.titleEdit`), or the editor would open on an invisible element.

**`isFrame` means an EXPANDED frame** (`view/layout.ts` tests `!collapsed`), and so does every question built
on it; a rule that must also reach the folded pill keys on the raw `n.type === 'frame'`.

**Anything that writes a node's `left`/`top` must go through `placeSelf`**, not a bare `place()` — that is
what `paintNode`'s final branch uses, and the relayout ANIMATION (`placeNodeEl`/`setNodeElXY`) writes left/top
too, since interpolating them IS the animation; `placeSelf` keeps a hosted card in its container's wrapper.

**A frame's content wrapper is LIFECYCLE-managed, not just created:** `frameContentEl` exists iff
`hostsContent(n)` (an expanded frame box) — `paintNode` drops it the moment that stops
holding. Being HIDDEN counts
as holding nothing (`hostsContent` is false for it), which lets the whole lifecycle be ONE drop placed ahead
of `paintNode`'s `isHidden` early return rather than repeated inside it. It is created lazily, so a fold/reopen round-trips through the same
code; a folded container's children ride along detached and are re-placed by `place()` when it opens. Skip
the drop and a fold strands an empty `overflow:hidden` div at the box's old size.

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
  persisted `mm_collapsed`, a scope is ephemeral, so the scope must never reach disk. Nothing flows cards, so
  opening and leaving move NOTHING and a visit writes nothing to disk.
- **The box becomes the VIEWPORT through `containerBox`/`frameInterior`**, as a DERIVED override. Hard
  invariant: the frame's own `n.w`/`n.h` are neither read there nor written, which lets it come back out at
  its authored size. `frameInterior` needs the guard too (it doesn't route through
  `containerBox`), and `frameContentTop` needs it because an open frame draws no tab to drop below — fixed
  there and NOT by making `isFrameBox` false for it, which feeds `nodeH` and would measure a `display:none`
  element and report a 64px frame. What still READS that rect is the drop test (`frameAt` skips the open
  frame, so a card on its canvas belongs to it via `detachParentId`).
- **That rect is a SNAPSHOT at k = 1, refreshed only on a window resize** (`scopeRect`/`refreshScopeRect`). At
  k = 1 — the app's canonical 1 world px = 1 screen px — rather than the live zoom, because opening then fits
  the camera, which would make a live reading circular; a snapshot rather than a live rect so it can't change
  under a pan. `bottomInset()` is excluded (it tracks the SELECTION via the docked float bar, so folding it in
  would move the rect on every click), as is the crumb bar, floating chrome like `#toolbar`. It's anchored at
  the frame's own content origin, so the coordinates its contents already have stay meaningful.
- **Double-click is still the way OUT, but no longer the way IN.** The empty canvas — which, once you're
  inside, is that same interior — leaves it (`features/gestures.ts`); at the top level there's nowhere to
  leave to, so the canvas keeps its "new card here". Going in is ⌥-double-click / two-finger double-tap, `↑`,
  the float bar's `⤢` or `⋯ → Open`. The crumb path and `↓` are the other ways out.
- **Leaving pops every SYNTHESIZED level under you, not one crumb at a time.** A level with no `back` is
  one nobody stepped through (`setScopeStack` records a back only on the level you newly enter), so opening
  something three frames deep pushes those frames as crumbs — and leaving one at a time would walk you out
  through folders you were never in. `exitScope` therefore walks down past them, and `goToScopeDepth`
  restores the back of the outermost level being left or, when that one was synthesized, the innermost that
  recorded one: the state the user was actually in before the whole excursion. `open A → open B → leave`
  still lands in A, because A kept its own back and stops the walk.
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
  nobody coloured, and painting the whole canvas *that* is a lie, and a near-white that swallows the chrome
  floating on it. Authorship, not the hex — a frame explicitly coloured white still tints. A FRAME's canvas is
  its PALE fill (`paleFill`), the same wash its box wears, so the full-colour cards it holds read on it.
- **At the TOP level that same variable carries the MAP's own colour** — `state.canvasColor`, per-map in
  `settings.json` beside the grid, so it travels with the vault rather than the browser. One resolver answers
  both, `canvasFill`, off `canvasOwner`: the open frame, or `null` for "the map". The
  `hasAuthoredColor` test applies only to the frame half — `canvasColor` is authored by definition, and `''`
  means the theme's background.
- **The canvas-colour BUTTON edits whichever of those two you're standing on** (`#canvasColorBtn`, one slot
  left of `#gridBtn`; `features/canvas-color.ts`). At the top level it writes `state.canvasColor`; inside
  an open frame it writes that FRAME's `n.color` — the same field the float bar would write if the frame were
  selected, so nothing new exists for the case. It reads `canvasOwner` too, so the chip on its face shows the
  value it would overwrite. Four things to respect: the chips are `properties.ts`'s row, not a copy
  (`swatchRowHTML`/`markSwatchRow`/`renderRecentChips` were split out of `createProperties` for exactly this —
  what can't be shared is that factory itself, being defined over node ids); the one difference is
  `FirstChip` — the map's own canvas gets a reset chip in the board's grey, since nothing else gets it back
  to "no colour"; both halves are undoable in the one timeline (a frame is an ordinary `record`, the map's colour
  goes through `touchCanvas`/`commitStep` and `Step`'s optional `canvas` field, as `state.strokes` already
  does); and the GRID INK is re-derived from whatever fill is behind it (`--grid-pat` on `#stage`, which
  `#grid` declares `--grid-ink` from — the theme's recipe with the canvas fill standing in for `--grid` and
  `inkFor(fill)` for `--text`, so an arbitrary picked colour needs no special case; without it a strong canvas
  colour either swallows the grid or turns it harsh).
- **`hostFrame` stops at the scope root**, which hosts nothing; `containerHost` (layout.ts) is the same walk
  without that exception.
- **`hostFrame` stopping at the scope root** is what makes "the box isn't there" true of the DOM and not only
  of the paint: its children are placed straight under `#world`, unclipped. The `.frame-content` wrapper is
  dropped by the existing ONE drop in `paintNode` (it's `isHidden`, so `hostsContent` goes false), and
  `edges.ts` shares the walk so connectors unclip in step. The `hostFrameId` cache must be cleared on every
  scope change, or elements keep being placed into a wrapper that's about to go.
- **Leaving GROWS the frame to hold what you put in it** (`growFramesToHold`), and only when something really
  sticks out: inside, the whole viewport was fair game, so a card can end up outside the box it goes back to
  being, where `overflow:hidden` would clip it into invisibility.
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
  payload roots, and a card dropped outside every frame. A real root would land outside the scope and vanish.
- **You can't drag a card out of the frame you're in**: its interior is the whole canvas, so there's nowhere
  visible to drop it to. Leave the frame before moving a card out.
- **Search is scoped; wikilinks and undo are not.** Search finds what's on the canvas, so every hit can be
  shown and selected. The map-wide
  jumps come OUT of as many levels as it takes first (`popScopeFor`), because `isSelectable` refuses an
  out-of-scope id and the step would otherwise look dead.
- **The open frame is never folded, and never missing.** `applyLayouts` repairs the first
  (a reload or an undo can re-collapse it — a blank canvas being the worst failure here, so `isHidden` checks scope-root identity BEFORE the fold as a third
  layer). `pruneScope` handles the second in the same pass, truncating the stack to what survives; the camera
  half of that recovery lives in `syncScopeChrome`. A reload re-mints every id, so `resolveScopeAfterLoad`
  re-points the stack by FILE before the first layout — deliberately not cleared like the undo history, since a
  background refocus reload must not kick you out of the frame you're working in.
- **The mechanism is kind-agnostic:** `canOpen` is the one kind test — widen it there, never at a call site.
  Frames and CARDS are in (see below).

**An OPENED CARD is its note** (`features/reading.ts`, `.node.reading-root`, `isReadingRoot` in
`nav/scope.ts`) — the other half of "you can open things". A frame's interior is the CANVAS; a card's
interior is its TEXT, drawn as one 680px full-height strip whose body scrolls. That is the whole reason it
exists: a card's height is measured (`nodeH` → `offsetHeight`, uncapped), so a long note is a 4000px-tall
card you can only PAN, and panning is not scrolling — no wheel semantics, no paging, and past `FAR_ZOOM` no
text at all.

- **It is THE CARD, not a rendering of it.** The same element `paintNode` already paints: its fill, its
  derived ink, its markdown, its links, its task boxes and its own `startBodyEdit` all arrive for free, and a
  note read on the page cannot look or behave differently from the same note on the board. `features/
  reading.ts` is ~45 lines because all it does is name the state; the strip is CSS.
- **So the scope root has ONE exception to being off the canvas** — `isReadingRoot`, spelled once in
  `nav/scope.ts` and read by both scope terms (`outOfScope` there, `isHidden` in `utils/model.ts`, a new term
  IN it rather than a predicate beside it). A FRAME's root isn't drawn because its box BECAME the viewport —
  a border round the whole window is not a frame. A CARD's root is the opposite: it is what you came to see.
- **The GEOMETRY is derived, not screen-fixed.** `nodeW` returns `readingWidth()` (`nav/scope.ts`, 680
  clamped to the window) for the reading root, ahead of every other arm. Nothing reaches `n.w`, so a card opened, read and left comes back out as authored. CSS adds
  only `min-height:100dvh` (full screen even for a two-line note) and reading type sizes, set as the same
  `--h1-size`/`--h1-lh` variables `.node .body h1` already reads. Keyed on `.reading-root` alone rather than
  `body.reading .node…`, since paintNode hangs the class on in the same pass a two-selector rule would miss.
  Reading MARGINS are the `--pad-x`/`--pad-y` VARIABLES, never `padding`.
- **Deliberately NOT `position:fixed`, and this is the load-bearing decision.** The card stays in WORLD
  space, so screen and world coordinates still line up and every hit-test keeps working exactly as on the
  board. A screen-fixed strip over a world-space canvas would put the pointer maths permanently out by the
  pan. The first pass got
  this wrong (it rendered the note into its own `#page` element, then into a `position:fixed` card).
- **All of it is measured ONCE per paint, into a band** (`refreshReadingBand`/`readingBand` in
  `view/camera.ts`, refreshed from `syncScopeChrome` and on a resize). The window's size, the strip's width
  and the card's own measured height are invariant for a whole pass, while `applyView` runs per pan frame
  and `paintPos` two to four times per node — reading them there put an `offsetHeight` per frame
  *inside* the paint loop's own style writes, which is a forced reflow each time. The band also carries
  `worldLeft` (the window's left edge in world coordinates).
- **"Fixed position and zoom" is the CAMERA, clamped in one place.** `clampReadingView` in `view/camera.ts`
  pins `k` to 1 and `x` so the strip stays centred; `y` is left free, and vertical panning IS the scroll.
  It sits at the top of `applyView` because that is the single place every pan/zoom path ends up — wheel,
  drag-pan, pinch, `⌘±`, `F`/fit, a glide — so one clamp constrains all of them instead of a guard per
  gesture, and `⌘±`/`F` become inert rather than needing to be caught. It writes `state.view` ITSELF and not
  just the transform: `screenToWorld` reads the model, and painting at k=1 while hit-testing at some other k
  is how a click lands on the wrong card. Opening sets only `y` (`READING_TOP - t.y`), clear of
  the crumb bar.
- **A scope LEVEL, deliberately not a panel beside the canvas.** One entry on the same stack, one crumb, `↓` /
  a crumb / `Esc` to leave, the file path in the same `open=` hash term — so back/forward, reload and
  bookmarks work with no navigation state of its own. Reading is somewhere you GO. The rejected alternative
  was a docked side panel: a panel and a card would show one note at once, which is what reads as two apps.
  (Scrintal takes cards "full screen to focus"; Obsidian Canvas's split-view-beside-canvas is a community
  plugin, not the design.)
- **`↑` / the float bar's `⤢` / `⋯ → Open` open it — NEVER double-click.** Double-click on a card's text edits
  it, because that is what a double-click means on text nearly everywhere and it is the commonest action in
  the app; gesture cost follows frequency. So `activateNode` tests the raw `type === 'frame'` rather than
  `canOpen` — the one call site where those two questions genuinely differ, and the line that stops widening
  `canOpen` from silently stealing the edit gesture. `⤢` lives on the float bar because that is the only
  action surface identical on desktop and touch (it docks to the bottom on coarse pointers); its test
  (`canOpenSelection`) also drops it on the card you are already inside, which `openFrame` would refuse.
- **`containerBox`/`frameInterior` and friends must NOT see it as a viewport.** The geometry helpers ask
  `boxIsViewport` (`nav/scope.ts`) — "the open node whose BOX became the window" — never `isScopeRoot`: a
  read card is an ordinary box on the canvas.
- **Vertically CENTRED while it fits, bounded scroll when it doesn't.** `clampReadingView` pins `y` outright
  while the whole card is on screen — so it cannot be scrolled at all, because a page that drifts under a
  gesture it doesn't need reads as broken — and clamps it between the two ends once the card outgrows the
  window, leaving `READ_PAD_TOP` clear of the crumb bar and the toolbar. The height itself is the content's,
  exactly as on the board: a two-line note is a two-line card, not an empty full-height slab.
- **A resize re-runs the LAYOUT, not just the camera.** `readingWidth()` follows the window, so the box and
  the centring both change with it — the resize handler calls `relayout()` + `applyView()`
  immediately for a read card rather than debouncing `refreshScopeRect` the way an open frame does.
- **A read card has NO HOST, and this one is a trap.** `hostFrame` returns null for it. Every frame above it
  is out of scope, hidden, and has already had its content wrapper dropped by `paintNode` — and a node whose
  host wrapper is gone rides along DETACHED with it. Without the guard, opening a card that lives inside a
  frame removes it from the DOM. A root-level card has no host anyway, which is why this only shows up once
  the card is in a frame.
- **The canvas behind it wears its PARENT's resolved colour** (`canvasOwner` returns `parentOf(open)` for a
  read card). Not its own — the backdrop would then be the very colour the card is painting and the card
  would vanish into it — and not the map's either, because what is behind a card is where it SITS: opening
  one inside a blue frame should still look like being inside that frame. Resolved, since `canvasFill` goes
  through `effectiveColor`, so an uncoloured parent keeps walking up. A root-level card has no parent, so the
  map's own colour shows — exactly what was behind the card before it was opened. And when the parent has no
  authored colour ANYWHERE up its chain, `canvasFill` falls through to the map's own canvas colour rather
  than to nothing: what's behind an uncoloured container is whatever is behind IT. Without that, going into a card on a teal board turned the board
  grey and coming out turned it teal again — and the identical discard applied to an uncoloured open FRAME.
- **The chrome it drops is dropped in JS, not shouted down in CSS.** `chipFace` returns `''` for it (no
  fold chip — folding the card you are standing inside would leave you looking at nothing) and the resize
  handles are cleared once AFTER the whole sizing chain, since a frame and a plain card each hand out their
  own: a DERIVED size isn't resizable. Both
  were `display:none !important` first, which meant out-shouting the hover/`:has` rules that reveal a chip,
  and left drag.ts refusing the gesture while CSS hid the handle — two guards for one fact.
- **It offers no line RINGS while it's open** (`connectable` in `view/free-edges.ts`). Everything outside it
  is out of scope and off the canvas, so there is nothing left to draw a line to — four rings offering a
  connection the canvas can't complete are worse than no rings. Added to `connectable` rather than beside it
  because that is the shared gate: the rings and the DROP refuse together, so nothing can be dragged onto the
  open card either. An edge to the open card is already hidden by its far end (`edgeVisible`).
- **Three consequences of the root being a real, visible card.** It must not be DRAGGABLE — the strip can't
  move on screen, but a drag would still write x/y to the file, so `dragPointerMove` refuses it exactly as it
  refuses a locked card. It is not the CANVAS's colour owner (`canvasOwner` returns null for it), or the
  background would be tinted with the very colour the strip is painting and the card would vanish into it.
  And `applyScope` skips the camera fit in favour of the reading camera above.

## Sizing

**`n.w` and `n.h` are always AUTHORED; a card's `n.h` is a MINIMUM.** Every kind gets the same 8 resize
zones (`FRAME_DIRS`, `ensureResizeHandles` in `main.ts`), and `n.w`/`n.h` (→ `board.json` `w`/`h`) are the
dragged size and nothing else — never a value a layout pass computed. What the height MEANS splits:

- `frame` is a **2D box** — 8 hit-zones, authoring both `n.w` and `n.h` (→ `mm_h`, gated by
  `isBoxType`). For a **frame** these are its box; its label hangs outside, above it.
- An **IMAGE card** is the third, and the one that isn't a kind: see below.
- `card` — its `n.h` is painted as `min-height`, never `height`: drag a card taller and it stays that
  tall, but its text can always make it taller still, so a card never clips its note and `nodeH` still
  MEASURES it (`offsetHeight`). The resize can't go below the text's natural height at the start width
  (`natural()` in `startNodeResize`). Minimum width is the kind's natural width; drag back to either
  natural size and that axis is dropped rather than persisting a redundant value. A legacy frontmatter
  `mm_h` is read for boxes only — a card's height is newer than that and lives in `board.json` alone.

**A card whose whole note is one image IS that image** (`soleImage` in `utils/markdown.ts` → `isImageCard`
in `core/state.ts`): untitled, body exactly one `![alt](src)`, nothing else. There is no image KIND — the
old `mm_type: image` folds to `card` on load (`foldType`) and stops being written on the next save,
so an old vault upgrades itself note by note and keeps its `mm_w`/`mm_h`. What being one buys is a render
and a geometry, both derived: no padding with the picture flush to the card's corners (`.image-card`), an
authored HEIGHT as well as a width (the one card `serializeMd` writes `mm_h` for), 8 hit-zones, and an
**aspect-locked** resize — `imageAspect` reads the loaded image's own ratio, so whichever axis you drag the
other follows and the picture never distorts or crops. Four things follow:
- **It's an ordinary card in every other respect** — it renames (which ends image mode: a heading is
  text), ⌥-merges into another note, sits in frames, and ⌥-drags out as its `.md`. That last one
  is what retired the old image-fold drag (`imageMerge`): an image card is UNTITLED, and `mergeCardsInto`
  already appends an untitled card's body alone, which for a picture is exactly its `![alt](src)` line.
- **The mode is the note's text, so it ends when the text does.** `isImageBox` (`main.ts`) adds the two
  states where the card shows something else and so measures like any card: while its EDITOR is open (that's
  markdown, which wraps), and while FOLDED. Type a word into the note and the padding and the measured
  height come back on commit, and `mm_h` stops being written — nothing to migrate, the file says it.
- **Folded, it's a 40px square of itself** (`isImageFold`, `IMAGE_FOLD`). A card with no title has nothing else to fold to, and an
  empty shell is worse than a thumbnail. The picture FILLS that square: `.body` has to override the
  one-line `max-height` every other collapsed body wants (that cap is for text, and it left the image
  letterboxed across the top), after which `object-fit:cover` crops the square out of any aspect.
- **The RESIZE is the third fold control**, beside the chip and `X`, and the only one that is also a size:
  scale the card down until its SHORT axis reaches `IMAGE_FOLD` and it becomes the icon, scale the icon
  back up and it's a card again — live, so the icon appears and goes under the cursor mid-drag. Which is
  why the folded icon keeps its 8 handles, and why an image card's `minWOf`/`minHOf` ARE `IMAGE_FOLD`:
  there is no smaller expanded size to clamp at, because below that it isn't expanded. What it unfolds to
  is the last EXPANDED size — the one it had just before the icon took over, not the size it started the
  drag at: you shrank it deliberately, and the chip should hand back what you shrank it to.
- **What rides on the icon is what fits on one.** The unfold chip has to be reachable, which is why
  `.image-card`'s title row is zeroed rather than `display:none` (`.hidden-count` lives inside that row)
  and why the chip carries a `z-index` at all — the body is absolutely positioned and later in the DOM, so
  the picture would otherwise cover the very control that folds it. The magnifier stays (a thumbnail is
  exactly when "show me this properly" is worth offering) but shrinks to 18px in the TOP-LEFT, the corner
  the chip and the add-child + leave free. The tag row goes entirely: it hangs off the bottom edge with a
  22px add-emoji button, which on a 40px square reads as chrome with a picture behind it.
  And the chip itself only shows when it's earning its place: the card is SELECTED, or the `+N` is really
  counting hidden descendants (`.wide`, set by `paintNode` for exactly that). A bare `+` on an unselected
  icon is neither, and an icon at rest should be a picture. This is the ONE per-kind exception to "no rule
  may hide the bubble", and it survives only because it out-specifies the `[data-chip="count"]` show rule
  instead of fighting a `:hover`/`.sel` one — plus scaling the icon up unfolds it with no chip at all.
- **It is named after its PICTURE** (`slugStem`, `data/persistence.ts`): the alt text, else the image file's
  own stem. `firstLineLabel` would slug the raw `![](attachments/…)` markup into something unreadable, and
  the note has no other text to be named from.
- **Every format goes down one path**, raster or vector: `attachments.ts` takes anything the browser calls
  `image/*` — or, when a drop hands over no MIME type at all, anything matching `IMAGE_FILE_RE` (the one
  list, shared with the importer). SVG needs no special case anywhere EXCEPT its intrinsic size:
  `createImageBitmap` refuses an SVG blob, so `imageSize` falls back to decoding through an `<img>`, which
  reports the size off its width/height or viewBox. Without that fallback every vector image landed as a
  generic `IMAGE_W`×`IMAGE_H` box instead of its own shape — and, being an image card, would then have
  taken that wrong ratio into its aspect-locked resize.

Resizing a card changes its measured height as text re-wraps, so the resize gesture paints *then*
re-lays-out on every frame (the same paint-before-measure rule as `prepRow`).

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
own recent writes (`state.lastSelfWrite`). It SETTLES pending writes first (`settleSave`) and refuses to
reload while anything is still unsaved (`hasUnsavedChanges`): `loadFromDir` replaces every node from disk, so
it used to read over an edit made just before switching away (it cancelled the queued save instead).

**A pasted LIST is many cards; capture never throws typing away.** `splitPastedList`
(`utils/paste-list.ts`, pinned by `tests/paste-list.test.ts`) decides whether a ⌘V of plain text is
a list: Markdown items (`-`/`*`/`1.`…, indented lines riding along as the item's body), or two or
more short bare lines with no blank line. Then `createCards` (`features/crud.ts`) makes one card per
item in a column under the pointer, stacked from MEASURED heights with `LIST_GAP`, in one undo step.
Anything with a heading, paragraphs or a lead-in line is a note and stays one card. Enter on a
top-level card puts the next card below it, below whatever already sits there, so Enter-Enter-Enter
builds a column. Every new card pops in (`popIn`, `data-pop`). Esc on a fresh card with text KEEPS
it (only an empty fresh card is discarded): Esc means "done typing"; ⌘Z is how a card is unmade.

**A status message is a TOAST, and most messages are not shown.** `setStatus` (`core/state.ts`) pops
`#status` at the bottom for about two seconds — for what the canvas can't show by itself: a refusal
("Locked — can't delete"), an action with nothing to see (Copied, Exported, Nothing to undo), a warning.
Messages that only narrate what just happened on screen (Moved, Pasted, Collapsed, Saved…) match
`QUIET` and are dropped, so the toast stays rare enough to be read. A new message that narrates a
visible change belongs in `QUIET`; a failed save is NOT a toast (it must stay up — `#saveAlert`).

**A save is never LOST, and never SILENT.** Four rules in `data/persistence.ts` + `data/save-alert.ts`:
- The 400ms debounce is flushed on `visibilitychange → hidden` and `pagehide`, and `beforeunload` asks the
  browser to hold the page while `hasUnsavedChanges()` — an edit made just before closing still lands.
- A failed write shows `#saveAlert` (the `#status` toast fades, so a failure can't live there) and
  retries on its own (2s, 5s, 15s, then every 30s) until a write lands; "Retry now" forces it.
- `saveAll` records progress AS it lands, so a throw half-way leaves exactly the rest pending: every note
  phase 1 decided to write is marked `dirty` (its `n.file` has already moved, so a retry can't re-derive the
  rename), `state.toDelete` shifts per removal, and a renamed note's old path waits in `pendingRemovals`.
- `board.json` is keyed by PATH and saves on its own 400ms debounce, so it can run while a new note is still
  nameless. `saveAll` re-schedules it whenever phase 1 gave a note a new path — or the newest cards' positions
  would never be written and a reload would drop them at the origin.
`tests/` (`npm test`) pins the format these writes produce: the `parseMd`/`serializeMd` round-trip, foreign
frontmatter kept verbatim, CRLF/BOM notes, and the pure naming rules in `utils/filenames.ts`.

## Interaction

**There is no toolbar; the ⌘K PALETTE is the one list of every action** (`features/palette.ts`, button
`#paletteBtn` for touch). The palette only displays; `paletteCommands` in `main.ts` builds the list, where
every action function is in scope. A command's `when` HIDES it while it can't apply rather than listing it
disabled. Each entry shows its shortcut, which is how shortcuts are learned now that the help map is gone —
so a new action gets a palette entry, or it is undiscoverable. Read-only shows a pill (`#roBadge`) that is
also the way out of it.

**Touch input:** pan/zoom on the canvas is a unified Pointer-Events gesture layer on `#stage` (one finger
pans, two fingers pinch-zoom + pan); node drag/reparent uses the per-node pointer handlers in `bindNodeDrag`.
`#stage`/`.node` set `touch-action:none`.

**The grid QUANTISES, and it is one rule for everything the pointer moves.** `snapTo` (utils/num.ts) is
the whole of it: a dragged card and a resized frame or image card are rounded to
the nearest grid multiple on EVERY move, so each of them is always sitting exactly on a grid position and
steps to the next as the pointer crosses the halfway line. Nothing is corrected at release, because
nothing is ever off the grid to correct. A card in a frame snaps relative to THAT box's corner,
since that is the space its position lives in, and a multi-selection is corrected by the anchor's own
offset, so the group keeps its internal spacing and moves as one piece.

Where it is applied, which is everywhere the USER decides a position — not just the drags. `snapPt`
(main.ts, beside `gridSnap`) is the placement half: a new card at the pointer and everything that routes
through `centredAt` (the canvas double-click, Space/N, both "New card here" menus, a dropped image, a
dragged-out selection), a duplicate (whose offset is a MEASURED card height, so it landed off-grid), a
paste (the anchor its payload lines up on), and an image pulled out of a note. What is deliberately left
unsnapped: the point where a line is split —
that one is snapped at creation but has to be able to sit anywhere along its edge afterwards. A Shift
drag was the one gesture that slipped through: it swaps the drag to a CLONE (`applyDragClone` re-keys
`drag.targets`), so a delta snapped for the original card found nothing and fell back to the raw pointer
delta — `snappedDelta` keys off `drag.active` for that reason.

**Smart guides PULL a drag by a few pixels, and win over the grid when they do.** `snapBox`
(`utils/guides.ts`, pinned by `tests/guides.test.ts`) takes the union box of the drag's roots at the
RAW pointer position and, per axis, pulls it within 6 screen px to the nearest edge-on-edge or
centre-on-centre alignment, exactly `SPACING` (20px) from a neighbour it faces, the gap of the pair it
continues, or the middle between two neighbours. `SPACING` is the house gap: a pasted list and an
Enter column use it too (`LIST_GAP`). A card in hand lifts by SHADOW only, never scale, so the
edges the guides align are the edges you see.
Neighbours are the drag's siblings in the same space, on screen. `features/guides.ts` draws one
pink rule per aligned position (the centre rule only when no edge lines up) and a ticked bar per equal
gap. An axis the guides claim skips the grid: guides read the RAW position because a 20px grid step
would otherwise jump past a 6px pull, and measured card heights put bottoms off the grid anyway. Off
for a reparent, a merge, Alt, and managed layouts; hidden on every drop and abort.

An eased pull toward the grid — a magnet, the value sliding toward the nearest line in proportion to how
close it was — was built and then removed, and the reason is worth keeping. Any pull is a GAP between the
pointer and the thing being dragged; closing that gap means the object travels faster than the pointer for
a while, and the object stops being pinned to the cursor. Tuned weak it was no magnet at all (a pixel or
two on a 20px grid); tuned strong it overtook the pointer by 3× and read as sticking and lurching; and
either way the object was somewhere the pointer was not. Quantising has the offset be a plain constant
inside the current cell instead, which reads as "this is snapped" rather than as lag — and it is what
every tool with a grid does, from PCB editors ("the logical cursor snaps from one grid point to the
next") to level editors. The cost is honest and expected: with `GRID_SIZES` running to 320px, a coarse
grid makes a card jump a long way at a time. That is what a coarse grid IS; the escape is the `No snap`
grid size (`gridSnap` returns 1, and every call site above becomes a no-op), not a softer snap.

**The page runs EDGE TO EDGE, and every fixed control adds the safe area back itself.** `index.html`'s
viewport meta carries `viewport-fit=cover`. Without it iOS lays the whole page out inside the safe area and
letterboxes the rest: an iPhone in landscape loses a ~50px strip of *canvas* down each side to flat
background colour (and a notch-height band at the top in standalone/PWA mode, where there's no browser
chrome covering it). With it `#stage` — `position:fixed; inset:0` — really is the whole screen, which is
what a canvas wants: the map can be panned under the cutout and nothing is clipped.

The insets then become ours to pay back, and they're paid ONCE, by name: `styles.css` declares
`--sa-t/--sa-r/--sa-b/--sa-l` at `:root` from `env(safe-area-inset-*)` (with a `0px` fallback, so every
`calc()` downstream is exact on the devices — all but a handful — that have no cutout at all), and each
piece of fixed chrome adds the matching one on top of its own 10–12px margin: the two top bars, the four
corner buttons, the dock, the docked float bar, the image viewer, the sheets,
and the two drawers. **Add the term to any new fixed control** — the failure mode is silent on every
desktop and on an iPad, and only shows up as an untappable button on the one device you didn't test.

Two consequences worth knowing. A *drawer* pays with PADDING, never by moving: `#storeSidebar` grows its
width by `--sa-l` and pads its rows inward, because a panel that slid inward would leave a strip of canvas
showing beside it and read as a bug. And a control anchored to a drawer's own edge (`.oc-back`, `.ol-head`)
takes the inset only in the full-screen phone case, where that edge IS the screen's — hence their
`max-width:700px` twin rules, written *after* the base rule they override rather than inside the media
block that owns full-screen mode, since equal-specificity selectors are settled by source order.

Panels placed by SCRIPT can't read those variables: `getComputedStyle` hands a custom property holding an
`env()` back unresolved. So `utils/dom.ts`'s `safeInsets` measures them off `.safe-probe` — a hidden,
zero-size element whose *padding* is the four variables, and computed padding is always resolved px. It's
cached (the float bar re-places itself every frame while it's open) and dropped on `resize`/
`orientationchange`, the only two events that can change an inset. `placeInViewport` — the one clamp every
floating panel, popover and context menu ends in — measures its margin from the safe edge rather than
`window.innerWidth/Height`, which under `cover` now includes the hardware.

**Collapse folds a CARD to its first line; frames don't fold.** `canFold` (main.ts) is the one rule: a card
with something below its first line, or an image card (which folds to a 40px icon). Entry points, all
through `toggleCollapse`/`toggleCollapseSelection`/`setCollapsedSelection`: the fold ARROW, `X`, the ⋯ menu,
`←`/`→` (directional, not toggles), and ⌘K's **Collapse all cards** / **Expand all cards** (`foldScope`: the
cards inside the selected frames, else every card on the canvas you're looking at). ⌥-click on an arrow
folds every card BESIDE that one (same frame or top level) to the state it goes to.

- **The arrow** is `.hidden-count` (the name outlived the old "+N" bubble): a ▾ in the card's left padding,
  level with the first line (`.titled` gives it a heading's height), turned to ▸ when folded. Faint until the
  card is hovered or selected; a FOLDED card shows it plainly. On an image card it's a small white button at
  the top-right. `chipFace` is the single thing that decides whether it shows (`data-chip`: `'count'` folded,
  `'fold'` open, absent = none) — locked and opened cards get none while open. It lives inside `.title-row`,
  and its `pointerdown` stops propagation so `bindNodeDrag` never turns the click into a drag
  (`NODE_CONTROLS` in drag.ts exempts it from the touch double-tap too).
- **A folded card** renders only its first line (`collapsedMarkdown`), greyed when the card is untitled
  (so it reads as the start of a note, not a name), and under it `.fold-more`: "N more lines"
  (`hiddenLineCount`, non-blank lines after the first).
- **Peek** (`features/peek.ts`): resting the mouse on a folded card for `PEEK_DELAY` floats its whole note
  beside it, in its colour. Nothing changes — no fold state, layout or save. Mouse only; any press, key or
  wheel puts it away. The panel is a `.node > .body` outside `#world`, so card text styles apply and nothing
  that walks the canvas sees it. Tapping a folded card's "N more lines" (`peekCard`) opens it on any device — the touch
  way in, since touch has no hover.

**A plain double-click MAKES OR EDITS; ⌥-double-click OPENS (`activateNode` in `main.ts`)** — no plain
double-click navigates any more, and that is one rule in place of a per-kind table. Editing is what the
gesture means on text nearly everywhere and is far and away the commonest thing anyone does here, so it keeps
the cheap gesture; going IN is held apart by the MODIFIER rather than by which part of the card was hit, which
is why it can mean the same thing on a card and a frame. Its touch spelling is a TWO-FINGER
double-tap (`features/drag.ts`), gated on a short tap so a pinch never registers as one; `↑`, the float bar's
`⤢` and `⋯ → Open` are the same verb without a gesture. The `open` branch sits ahead of the read-only bail,
the exemption `openFrame` itself takes: looking inside something isn't changing it.
Everything else is still dispatched by WHAT WAS HIT, so it covers every kind without a per-kind entry point: a
`.title-row` (a card's title row, a frame's folder tab) renames via
`startInlineEdit` — the single rename funnel, so the FRAME
hand-off and the lock refusal come for free; anything else
on a card edits its note (on a card those two are the same editor with the caret in a different place). A
FRAME's interior gets a new card WHERE YOU POINTED (`addCardInside`, which refuses a locked frame and
reveals a folded one) — a 2D box is exactly the container where "here" means something.
The same gesture on empty canvas creates a root card (`stage`'s
`dblclick` in `features/gestures.ts`) — **or, while a frame is open, LEAVES it**, since the canvas then IS
that frame's interior. Going in and coming out being one gesture is most of what makes a frame feel like a
folder; making a card inside an open frame is `Space`, `Tab` and the canvas right-click, which all land it in
that frame (`detachParentId`). Four things hold it together:

- **The INNERMOST node owns the gesture, including the ones it declines.** Child cards are DOM-nested, so both
  handlers (`nodeEl`'s `dblclick`, the touch double-tap in `features/drag.ts`) `stopPropagation` BEFORE their
  bails, not after — otherwise a gesture this card refuses bubbles to its host card, which reads it as a
  double-click on itself, opening the HOST's editor and sending the rest of the typing into the parent's note.
  On touch it's worse, since each ancestor keeps its OWN tap counter. A container's children are exempt by
  construction — they live in its sibling `.frame-content` wrapper, not inside its element.
- **`NODE_CONTROLS`** (`main.ts`) is the one list of things that act on a SINGLE click — chip, checkboxes,
  links, `.addnote`, resize handles `.fh`. Both the `dblclick` handler and the touch double-tap
  counter bail on it, or the second click would fire the button AND open the card.
- **A folded node is nothing but its title** (`.node.collapsed .body { display:none }`), so EVERY hit on it
  renames — otherwise a double-click would open an editor inside a hidden `.body`.
- **Read-only keeps the old meaning** (fold/unfold, the one thing the mode allows). The short-circuit sits
  ahead of everything, so a read-only double-click on a frame FOLDS it rather than opening it — `↑` and the ⋯
  menu are the routes in.

**A click now only ever SELECTS.** Don't reintroduce a slow-second-click rename timer: it can only race the
double-click it was invented to lose to.

**Pasting a URL over selected text LINKS it** (`linkPaste` in `utils/markdown.ts`, bound by
`pasteUrlLink` in the card's note editor). It is
the one thing `[label](url)` costs that a rich editor's ⌘K doesn't, and the rule is the render regex
read backwards, so it can't link text `mdLinks` wouldn't then show as a link. A selection that already
touches a link keeps its LABEL and takes the new URL — including when the selection is wider than the
link, since a link inside a label is invalid markdown and rewriting the one that's there is the reading
that can't produce a broken note. It stands aside (native paste) for an empty selection, a multi-line
one, a paste that isn't a bare URL, and an image's `![alt](src)`. The handler writes nothing but the
textarea and then dispatches `input`, so the editor's own live path runs exactly as it does for typing.

**The card editor WRITES a little markdown for you, and nothing more** (`utils/md-edit.ts`, bound in
`onBodyKeydown`). Enter in a list item starts the next one (the next number, a fresh `[ ] `), and Enter on an
empty item ends the list; ⇧Enter is always a bare newline. Tab nests the touched lines one level and ⇧Tab
lifts them — a level being the item above's MARKER WIDTH (`- ` 2, `1. ` 3), so the indent is the one
CommonMark and Obsidian read as nesting — and Tab never moves focus, which used to blur the card shut.
⌘B / ⌘I / ⌘⇧X wrap or unwrap `**` / `*` / `~~`, reading a run of stars whole so italic and bold compose. No
⌘K for links: the palette owns it, and pasting a URL over a selection already links. The textarea itself
stays plain text (monospace, since it shows SOURCE); styling the text while editing was weighed and parked.
- **Every helper is pure text → `{text, start, end}`** (`linkPaste`'s shape) and goes through ONE writer,
  `applyTextEdit`, which replaces only the changed span with `execCommand('insertText')`: assigning
  `ta.value` wipes the textarea's own undo stack, so ⌘Z inside the editor would undo nothing.
- **In a pipe TABLE, Tab walks the cells and Enter adds rows** (`tableTab`/`tableEnter`, tried before the list
  keys): Tab selects the next cell's text, stepping over the delimiter row, and adds a row past the last cell;
  Enter adds a row under the caret's, an empty LAST row ends the table, and Enter at the end of a lone
  `| a | b |` line starts one. Each also TIDIES that table — cells padded so the pipes line up in the monospace
  editor (wide characters count two), the delimiter rebuilt keeping its `:` alignment. Only on those keys and
  only that table, so no note is rewritten behind your back. What counts as a table is the renderer's own
  `tableAt`/`tableRow`, so the editor never tidies something the card doesn't draw as one.
- **The renderer nests lists by indentation** (`renderList`): deeper than the open level opens a list inside
  the item above, shallower closes back to the level it matches, a marker change at one level starts a
  sibling list. Tasks stay bullets-only, numbered in body order, because `toggleTask` counts `- [ ]` lines.

**MERGING notes and BREAKING them apart are two DRAGS, not two commands** — where Scrivener and Ulysses put
list commands on a multi-selection, a canvas has a place to point at. No menu entry, no shortcut for either;
adding one is a decision, not a gap. Neither writes a new frontmatter key — a merge is a body edit plus a
delete, a break is a body edit plus a create.

- **⌥-drop card(s) onto a card MERGES them into it** (`mergeDrag`/`cardMerge` in `features/drag.ts`,
  `mergeCardsInto` in `crud.ts`). The card you dropped ONTO survives — its id, file, colour, size and flags —
  and each dragged note folds into its body as `## Title` then its text, in selection order. Tags are unioned
  in. `canMerge` is the ONE kind test and answers for both sides: a plain card. Every other kind
  is a box whose shape is the point.
- **⌥ is free for it** — a plain drag moves (in and out of frames), ⇧ clones, ⌘ toggles the selection. One
  knock-on: `paintDetachPreview` (⌥
  pressed mid-drag) goes through `dragFollow`, so the target's outline appears on the KEYPRESS rather than the
  next mouse jiggle.
- **Dragging a card's selected text OUT of its editor BREAKS it apart** (`features/text-drag.ts` →
  `dropCardText`), after Heptabase's whiteboard gesture: drop it on empty canvas and it becomes a card of its
  own, in a frame and it becomes a card THERE, on another card and it's appended to that
  note. Always a MOVE — the text leaves the source, whose editor is DROPPED rather than ended, since
  `endBodyEdit` would write the editor's stale value back over what was just cut. `TextSource`
  (`{id, start, end}`) is the range, captured at `dragstart` and read back live at the drop (`liveText`), since
  the offsets are into what the EDITOR shows, not into `n.title`/`n.body`. **Dragging a card's NAME out is the
  same gesture and needs no second arm**, the name being the `# ` line inside that very field: `cutCardText`
  re-SPLITS whatever is left, so cutting the heading away just leaves the card untitled.
- **Where the new card belongs is the drop rule**: dropped in a frame, it's that frame's card; on the open
  canvas, the top level (`detachParentId`) — dropping on the canvas is how a note comes OUT of a frame. Splitting the dragged lump is `splitHeading`
  itself — a leading `# ` line becomes the new card's title, and without one the card is untitled and the whole
  lump is its body. Shared with `⌘⇧E`.
- **What rides the cursor is a CARD** (`buildGhost` → `setDragImage`, `.node.drag-ghost`), not the browser's
  default snapshot of the dragged LETTERS: a real `.node` captioned with the text's own first line
  (`firstLineLabel` — the WIDE read: any first line makes a caption, where only a `# ` line would make a real
  title), tinted with the SOURCE card's resolved colour, since that's what a card beside it would inherit. It must be
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
folder you're standing in, and whether a frame or note is folded. **Walking between cards lost its keys to
that**, deliberately: opening a frame is the primary way to move around a big map, and clicking covers the
rest. The keys no longer pan — `↑` re-frames via
`frameBox`, `↓` glides back to a remembered camera, `→`/`←` don't move the camera at all (`revealInView`
survives for its other callers). Two details: `←`/`→` are
DIRECTIONAL rather than toggles (pressing `→` twice can't fold what it just unfolded, and a MIXED selection
lands on one state in a single press). They act on the WHOLE selection via the directional sibling of `toggleCollapseSelection`,
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

**The full-screen viewer PAGES through a card's neighbours** (`features/image-viewer.ts`): ‹ / › and ←/→
step across every image in the notes that share the opened card's parent — a frame's contents, a branch's
siblings — in canvas reading order (top-to-bottom, then left-to-right, then each note's own order), wrapping
at both ends. The run is built from the NOTES, not the rendered DOM, so a FOLDED sibling's pictures are in
it too (they're no less part of the set for being tucked away), and each path resolves through the same
per-path cache the cards' own images use (`imageUrl`, `features/images.ts`) — so an image that has never
been on screen loads once and paging back is free. Two details: the arrows are hidden unless there is a run
(`.iv-paged` — a lone picture showing two dead buttons is worse than showing none), and the key handler is
registered in CAPTURE and stops what it handles, so ←/→ never reach `navArrow` underneath and Escape closes
the viewer WITHOUT also clearing the canvas selection. **SPACE opens and closes it**: on a lone selected
image card the picture IS the card, so "look at this properly" is what the key can mean there (`openImageAt`,
`main.ts`, shared with the magnifier button), and it sits ahead of the new-card branch, which only ever ran
with nothing selected. Space is split across the two key events on purpose — the keydown is swallowed so
`spaceHeld` can't latch the canvas into hand-pan, and the keyup does the closing, which also stops main.ts's
own Space keyup from re-opening the viewer on the card that is still selected. **Closing lands you on the
card you were LOOKING at**, not the one you came in from: page three pictures along, close, and the third
card is selected, so the next thing you do lands where your eyes already were. Selection only — the camera
stays put.

## Colour and zoom

**ONE theme, FigJam's.** There is no light/dark switch: a pale grey board (`--bg` #f5f5f5) with a dot grid,
white chrome on a soft shadow (`--shadow-ui`), Figma blue (#0d99ff) for selection, and DARK islands for the
object toolbar, its popovers and the context menu (`--bar-*`). One theme means a map looks the same
everywhere, and a colour has exactly one ink. An uncoloured CARD falls back to `amber`, the sticky
yellow — derived, never written, so the note on disk stays uncoloured — and an uncoloured FRAME to `white`.
The keys (`amber`, `slate`, …) are the file format; only the hexes in `styles.css` may change.

**The colour picker is FigJam's: two rows of eleven** (`PICKER_ROWS`, main.ts) — the STRONG hues framed by
black and white (`stone`, `bold-red` … `bold-pink`), then the pastels, the sticky colours, framed by two
greys and ending in the custom chip; recently used custom colours wrap onto a third row. `PALETTE` is every
key a note may carry (a superset: `slate` still paints but is no longer offered), and its `.c-<key>`
classes are GENERATED beside their ink (`deriveInk`), so a new key is its `--pal-*` hex plus one array
entry. There are no "inherit" or "none" chips: a card nobody coloured keeps following its frame, and the
picker rings the colour it SHOWS (`effectiveColor`) — the selected chip wears FigJam's violet ring. A line's
default ink IS `stone`, so the line picker needs no "default" chip either.

**Selection, ports and lines are FigJam's.** A lone selection shows a white rounded square on each corner
(drawn on the corner resize zones, `.node.solo > .fh-*::after`), and four PORTS float `SOCKET_OUT` outside
its sides — a blue dot in a white rim that becomes a ⊕ under the pointer (free-edges.ts). DRAG from a port
to draw a line; CLICK it (a press under `MIN_DRAG_PX`) and `spawnConnected` (edge-tools.ts) makes a card
`CONNECT_GAP` away on that side — the source's colour and size, in the source's home, joined by a line,
open for typing — stepping past cards already there so repeated clicks fan out. It is one undo step with
the card, so an abandoned empty card takes its line with it (`discardNewCard` → `deleteNodes`). While a card is
being EDITED the card itself is the field: the textarea is bare (no box, no scrim), the ring turns a dimmed
3px blue (`--edit-ring`) round the card's border and the corner handles stand down
(`.node.sel.card-editing`); a frame's label being renamed rings its PILL the same way. The card never
changes size as editing starts: the textarea is one row (`rows = 1`) and the card holds the height it
had (`BodyEdit.holdH` → min-height in paintNode) until the editor closes — it only grows if you type
past it. While a line end is dragged, the target card shows its ports; the one within `PORT_SNAP` fills. The float bar sits `GAP` (36px) above the selection, clear of the top port. Lines
are 3px (`STROKE_W`), stop `END_GAP` short of the cards they join, and end in a wide open chevron. A lone selected line shows FigJam's end
handles — white discs with a 3px blue rim, ON the card rims where it attaches (the drawn ends stepped back
by their trim) — and no outline; a multi-selection, which has no handles, outlines each line instead. The
line's toolbar (`#edgeBar`) never covers the line: it sits above the route's whole bounds (`Geometry.box`,
untrimmed ends included), or below when there's no room, and its pickers open on the side away from it.

**The context menu is FigJam's** (`#ctxMenu`, `features/context-menu.ts`; a card's entries are
`buildCardMenu` in float-bar.ts, shared with the bar's ⋯). Groups, in FigJam's order: the clipboard
(Copy/Cut/Paste/Duplicate), Delete, what you can do with it (Edit or Rename, Open, Collapse, Group,
Fit frame), where it goes outside the map (file path, download, share), and Lock last. Only actions with
no easier home: a new card beside one is the port ⊕, a card inside a frame is a double-click, zooming is
F. Rows are 24px, text 16px from the edges, the shortcut grey at the right, the hover a rounded blue row
inset 8px, and no red Delete.

**Toolbar metrics.** Every dark island (float bar, edge bar, popovers, menu) and the dock share
`--r-bar` (12px). Icons are 18px (`--bar-icon`) in 32px buttons; dividers (`.fb-sep`, `.dock-sep`) run
the bar's full height with 6px either side; the colour dropdown is flat until hovered. A popover floats
`POP_GAP` (8px) off its bar with no stem joining them. Every button that opens a menu or popover is a DROPDOWN (`.fb-dd`): its
face then a grey chevron (`chevron()` in view/icons.ts for faces rebuilt in JS) — the colour dots, ⋯,
the edge bar's line style (a Solid/Dashed popover, `ebDashPop`) and ends, the dock's canvas colour and grid.

**Tidy-up runs only when asked** (docs/PRODUCT.md, principle 2): the float bar's ▦ dropdown (shown for two
or more selected), ⌘K, and FigJam's shortcuts (`⌃⌥T` tidy, `⌥A/H/D/W/V/S` align, `⌃⌥H/V` space evenly —
matched by `e.code`, since ⌥ rewrites letters on a Mac and Alt+D still reads `d` elsewhere). The geometry is
pure (`utils/tidy.ts`, pinned by tests/tidy.test.ts); `features/tidy.ts` applies it to the top-level
selected nodes (a frame carries its cards) as one undo step with the reflow glide. **Tidy up** reads the rows
the selection already forms (`rowsOf`: a box joins the row above when it overlaps it vertically at all and
shares no column with a box in it — so a messy column stays a column, a drifting row a row) and lays them
out as a grid: columns as wide as their widest box, `SPACING` gaps, from the selection's snapped top-left,
order kept. A frame's box counts its label. With several selected, the float bar sits above the whole
selection, not over one card of it.

**The dock** (`#dock`, bottom centre) is FigJam's main toolbar: the sticky you drag a new card off, the
board's canvas colour and grid, and ⌘K, in groups split by hairlines. Its buttons are ordinary
`.floating-btn`s that drop their own chrome inside it, and every popover/menu they open is placed from the
button's rect, so none of them knows where the dock is.

**The look: a FigJam board of sticky notes** (docs/PRODUCT.md). Type is the system's rounded face, else Nunito
(bundled latin subset, `src/assets/fonts`, OFL). A sticky is near-square-cornered (`--r-card`, 3px) and sits on
FigJam's soft lift (`--lift`); a card in hand casts a deeper one (`.dragging`); frames, folded pills and
pictures stay flat. Motion uses the `scale` property, never `transform` (the drag and
the relayout animation own that): a new card pops in via a `data-pop` attribute (a class would be wiped by
paintNode's wholesale `className` rewrite), and a card in hand lifts by a SHADOW only (never a scale, so
the smart guides line up with the edges you see). The pop stands down under reduced motion.

**A card's text colour is DERIVED from its fill, never authored.** The palette hexes are the `--pal-*` custom
properties in `styles.css` (one source of truth, read into JS as `SWATCH_BG`), but the **ink** each demands is
computed: `utils/ink.ts` measures WCAG contrast and `main.ts`'s `deriveInk` injects a `--pal-ink-*` +
`--pal-scrim-*` pair per key into a generated `<style>`. The `.c-*` classes hand those to a card as **`--ink`**
(its text colour) and **`--scrim`** (what an in-place editor paints *behind* that ink). Four rules follow:

- **No rule anywhere may name a colour key to fix its text.** One `color: var(--ink)` per surface that wears a
  `.c-*` class covers every colour — that
  replaced four hand-maintained exception lists that all had to agree, and it's what lets an off-palette colour
  work with no new CSS.
- **`--scrim` is paired with the ink, not fixed.** Every editor backdrop (`.title.editing`, `.body-edit`,
  `.oc-title:focus`, `.ol-title.editing`) uses it: a hardcoded dark scrim under dark ink is
  unreadable. Same reason the body's marks (`code`, `pre`, `blockquote`, `hr`, image placeholders) tint with
  `color-mix(… var(--ink) …)` instead of a literal white/black.
- **Ink is a property of the CARD's fill.** `c-none` is the one exception, by construction: with no fill
  there's nothing to measure, so it takes `var(--text)` and has its scrim set by hand.

The bias is deliberate: light ink is kept unless its contrast falls below `INK_MIN` (**2.5**) rather than always
taking the higher contrast. With FigJam's pastels every palette colour falls below it and takes dark ink
(`#1e1e1e`) except `black`; the bias matters for an off-palette custom colour.

**A colour VALUE is a palette key OR an authored `#rrggbb`.** `n.color` (and `effectiveColor`'s result) is `''`
(inherit), `'none'`, a key, or a custom hex from the colour popover's spectrum chip — and **nothing branches on
which**, because three resolvers in `main.ts` absorb it: `colorFill` (the hex JS tints with — edges,
the canvas; `null` for none/inherit, which every caller already falls back to `--edge` for), `colorClass`
(`c-<key>`, or `c-custom` — a hex can't be a class name) and `colorVars`/`applyColorVars` (that node's
`--card`/`--ink`/`--scrim` written inline, since the set of custom colours is open-ended and only a class can
carry pre-computed ones). Use them at **every** site that turns a colour into a class or a tint — the class
sites are `paintNode` and the swatch rows — and
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
+ `sel` Set), `readOnly`, `canvasColor`, the grid settings, … Every field is either the notes
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
