# Spec — edges and containment

**Status: PARTIALLY IMPLEMENTED** — see "Implementation status" at the foot of this file. This describes a change to how hierarchy and relations
work on the canvas. It supersedes parts of [architecture.md](architecture.md) and [CLAUDE.md](../CLAUDE.md)
only once implemented; until then those two describe the app and this describes the intent. Written in
the same style: topics are findable by their **bolded lead sentence**, and symbol names are the contract.

## Why

Corkboard today has exactly one relation between two cards: `mm_parent`. It is drawn as a branch edge
and it carries everything at once — layout, collapse, scope, file placement. There is no way to say
"these two cards are related" without also saying "this one belongs to that one and moves with it".

The obvious fix — add a second kind of line — was rejected after looking at how the field solves it.
Every mind-map tool that ships both (MindNode "Connections", SimpleMind "cross links", XMind
"Relationships", TheBrain's "Jump" links) keeps them apart by making the second one rarer, differently
created, and differently named. That works, but it leaves two line types on the canvas that a user can
style into each other, and it leaves the branch line carrying five jobs.

The route taken instead is Heptabase's: **hierarchy is expressed by CONTAINMENT, never by a line, and
every line on the canvas is a relation that means nothing structural.** One kind of line, one kind of
nesting, and the two can never be confused because they are not the same shape of thing.

## The model in three sentences

A card's children live INSIDE it, never beside it. Anything with children is a container, and kinds
differ only in how they arrange what is inside them. Every line on the canvas is an edge the user drew,
and edges affect nothing.

---

## Containment

**A card with children IS an outline; the `stack` kind goes away.** Today `mm_type: stack` names a card
whose children are laid out as outline rows, and `isContainer` is `isFrame(n) || isStack(n)`. After this
change a plain card that has children renders exactly that way, so the kind carries no information the
child list doesn't already carry. `isContainer` becomes "has children". Remaining kinds: **card, frame,
annotation, query**.

**A child is always within its parent's bounds.** This is the containment rule, and it is what replaces
the branch line: you can see what belongs to what because it is inside it. Three consequences:

- A container's height is DERIVED from its contents and can never be authored. `mm_h` stays what it is
  today — frame, query, and an image card — and `mm_w` stays authored everywhere.
- **Dragging a child out of the parent's bounds detaches it**, dropping it on the canvas at that
  position. Without this, nesting is a one-way door.
- Depth costs nothing. A card's children are outline rows, so nesting is indentation, not boxes inside
  boxes. "Open this as a canvas" therefore stays a FRAME feature and is not needed for cards.

**A frame stays a distinct kind** — the container whose children are placed spatially rather than
outlined. `mm_layout` still selects its arrangement (free / grid / tabs), it can still be opened as a
canvas with breadcrumbs, and it is still the answer to "group these cards without ordering them".

**Annotation, query and image cards refuse children.** An image card in particular is DEFINED by its
note being one `![](…)` and nothing else (`isImageCard`), so a child area would contradict the thing
that makes it an image card.

**`mm_side` is gone.** Left/right placement around a parent has no meaning when children are inside it.

**There is no root.** `isRoot` keeps its current definition — no resolvable parent — and means only
"loose on the canvas". No central-topic concept survives anywhere in the UI.

## Edges

**An edge is a first-class object, not a rendering of something else.** It has a persisted id, two
endpoints, and its own styling. It is selectable, has its own floating menu, and can be deleted. Deleting
an edge never deletes a card.

**An edge means nothing structural.** It does not move cards, does not collapse, does not hide, does not
place files. This is what makes drawing one always safe: no gesture that draws a line can reorganise the
map. Re-parenting is what it is everywhere — you drag the card.

**Creating an edge:**

- Select a card → four hollow socket rings appear at its side centres → drag from a ring to another
  card. Rings appear on SELECTION, never on hover. (Miro's four dots are always live, and its own
  community complains steadily about accidental connectors; selection-gating is the fix.)
- Or select one or two cards → **Connect** in the float bar (`⌘L`, MindNode's shortcut). Two selected
  connects them; one selected arms connect-mode and the next card tapped completes it, Esc cancels.
  This is the touch path — iOS never fires `contextmenu` on long-press, and Obsidian Canvas's iPad
  connection flow is the cautionary tale.
- Dragging to empty canvas creates a new card, connected.

**An edge docks to a PORT, and keeps it.** Each end stores which face of its card it is attached to
(`EdgeSide`, core/state.ts) — the ring you dragged from, or the face nearest where you dropped. It is
never re-derived: an edge that re-picked its nearest face on every paint would slide around its cards
as they move, and a diagram you arranged would rearrange itself under you. Move a card and the line
follows its ports; to change one, drag that endpoint.

**A stub is capped at half the room it has.** A line runs straight out of each port before it may turn
(`STUB`, 28px), but a fixed stub longer than the gap it has to cross makes the two stub ends overshoot
each other — and then every candidate route doubles back, the no-reversal search falls through to its
last resort, and a SHORT edge comes out as a rectangular loop out and around. `stubFor` caps each end's
stub at half the distance the other end lies ahead of it: at exactly half, two ports facing each other
meet in the middle and the route collapses to the straight line it always wanted to be. An end that the
other one sits BEHIND keeps the full stub — it has to come out and go round, and it cannot overshoot.
The one-turn L test measures against the same capped stubs, or a short edge would be refused the single
bend it wants and sent back to the dog-leg.

**An arrow-tipped end stops half a line-width short of its port.** The head is stroked and never filled,
with a round join, so the paint reaches `STROKE_W/2` past the geometric tip: land that tip on a card's rim
and the point of the arrow is 2 world px INSIDE the card, merging into the border it is pointing at.
`routeFor` takes a trim per end and `edgeGeometry` asks for it wherever the cap is an arrow (`ARROW_INSET`),
so the painted tip lands ON the rim. The whole END moves, not just the head — `a`/`b` come back off the
trimmed route, so shaft, head and endpoint handle stay at one point. A `dot` is untrimmed on purpose (it is
meant to sit centred on the border) and a bare end has no overshoot to pay for. The draft mid-drag is
trimmed the same way, so nothing shifts on release.

**There is ONE route shape.** Once a line leaves a NAMED face it has a direction to respect,
and right angles are what make "this leaves the right side and enters the top" legible. It runs a
short stub straight out of each port before it is allowed to turn, so an edge never bends back across
the card it just left. The corners are drawn generously round (a cubic arc at each bend, clamped to
half the shorter leg), so the route stays orthogonal in what it SAYS while looking organic. There is
no style picker: one shape everywhere is what keeps a map's lines reading as one hand.

**Drop an end ON a line and it SPLITS: that is a JUNCTION.** Three lines can meet somewhere that isn't
a card, and the place they meet is a `Junction` (core/state.ts): an id and a world position in
`board.json`, beside the edges — never a node, because it holds no content and so wants no `.md` file
and no place in the hierarchy. It is the ONE way one comes into being, and it explains where the third
line comes from: the target edge becomes two edges meeting at the new point (`splitEdgeAt`), the first
half keeping the original's id, label and far cap, the second carrying its colour, dash and other cap.
Dropping on an existing dot (`junctionSnapAt`) joins it instead of splitting anything, so a fourth and
fifth line meet at the same point rather than at points a pixel apart.

A junction can only ever be created ON the grid: the drop point is projected onto the line and then snapped
(`junctionPoint`, view/free-edges.ts — ONE answer, so the preview and the commit cannot disagree). It
therefore does not land on the line's old path, and does not need to: both halves re-route through the point
the moment it exists. If a junction already sits at that grid position the drop meets THAT one rather than
stacking a second dot on it.

While the end is being dragged over a line, the preview shows a GHOST of the dot at exactly the grid point
the drop would use — hollow and dashed. That answers "what will this do?" with a picture of the thing it is
about to make; marking the target LINE instead only said which line, and said it by making a second line
look selected.

**Only the SPLIT clears terminators, and only at the cut.** The two halves a split leaves would otherwise
grow a head each in the middle of what the reader sees as one line, so `splitEdgeAt` sets the head's `toCap`
and the tail's `fromCap` to `none` — as an EDIT to those edges, not as a paint-time exception, so the caps
on disk stay the truth about what is drawn and the edge bar can put one back. Every OTHER line keeps its
caps wherever its end lands, junction included: an end meeting a point is still that line's end, and its
arrow is what says which way it runs. A merge inherits the far end's cap, so a dissolved junction gives back
a properly terminated line.

**A junction is a BRANCH — three lines or more — and anything less DISSOLVES.** `gcJunctions`
(data/board.ts) is where that invariant lives, and it runs after every detachment, every undo, and once
before each save:

- **two** ends left — the point is merely somewhere a line passes through, so `mergeThrough` puts the two
  halves back together into the one line they were before the split. The survivor keeps its id, colour,
  dash and label, and takes over the far end, port and cap of the one it absorbs. This is what happens when
  you pull the third line off a branch or delete it: the dot goes away by itself and leaves a line, not a
  kink. A merge that would join something to ITSELF drops both halves instead.
- **one or none** — nothing to merge, and an edge cannot keep an end on a point that is not there, so the
  leftover line goes with the dot.

Looped, since either outcome can strand the junction at the far end of what it just changed. A board that
arrives ill-formed (hand-edited, or written by an older build) heals on load.

**There is nothing else you can DO to a junction, deliberately.** It cannot be selected, it has no
properties and there is no command to delete it: pull one of its lines off (or delete that line) and the
point dissolves itself into the remaining two. A selection kind, a Delete branch and a right-click removal
all existed for a while and all came out again — with the dissolve rule in place they were three ways to ask
for something the model already does on its own. A dot is a thing you MOVE, and that is all.

**Dragging the dot moves it and every line follows** — that is why a junction is one shared entity with an
id rather than coordinates copied onto each end — and the drag is snapped to the grid exactly as a dragged
card is (`snapTo`, utils/num.ts — see the quantising note in architecture.md): rounded on every move, so the
dot is always on a grid position, which is the same grid its creation was constrained to.

**An end dropped on nothing is thrown away.** A re-route that reached no card, no junction and no line
deletes its edge — the gesture for discarding one. What guards it: a release must have travelled
`MIN_DRAG_PX` to count at all, so a twitch on a handle is a press and changes nothing, and Esc or a
cancelled pointer aborts a draw outright (both used to commit it).

**Editing an edge:** selecting it shows both endpoint handles — drag either onto another card to
re-route, onto another LINE to split it and meet there, onto an existing junction to join it, or off
onto empty canvas to throw the edge away.

**The draft IS the edge, terminators included.** While a drag is live the preview carries the same stroke,
colour, dash AND caps the finished line will have, at both ends and wherever the pointer currently is —
nothing is withheld for being mid-air, because the draft's job is to show the edge, not to promise a
landing. One subtlety it has to get right: the draft is drawn from the end that is STAYING to the end being
dragged, so dragging the `from` end runs the edge BACKWARDS (the anchor is its `to`). The caps are read in
draft order for that reason; reading them in edge order is what used to put the arrowhead on the wrong end
for that half of the gesture. **Double-click the line to label it in place**, in a
field over the line's own midpoint: the same gesture that opens a card's text, and the caret lands
where the result will appear rather than in a bar off to one side. Its menu is deliberately small:
**colour · solid/dashed · direction · delete.** Direction is an explicit three-way picker (none /
one-way / both), not a cycling button — a cycle hides two of the three states behind guesswork.

**Arrowheads never imply hierarchy.** Direction is semantics the user writes ("causes", "feeds into").
Containment is structure. The two axes never touch.

**An edge hides when either endpoint is hidden** — collapsed ancestor or out of scope, the same
`isHidden` gate as everything else. **The count pill keeps counting CARDS ONLY**; an edge vanishing along
with the card it points at needs no explanation.

---

## Storage

**`board.json` is one sidecar replacing several.** The folder already carries `sketch.json`
(`SKETCH_FILE`, persistence.ts) and a small per-map view-preferences file, so this consolidates existing
sidecars rather than introducing the first one. CLAUDE.md's "no database, no sidecar" needs rewording to
match what is actually true: **no database, and ONE board file that holds arrangement — never content.**

`board.json` holds:

- **edges** — id, both endpoints AS PATHS, colour, dash, arrows, label.
- **geometry** — position, size, collapse state, and child order.
- **sketches** — absorbing `sketch.json`; read either, write only `board.json`.
- **per-map settings** — what the view-prefs file holds today.

**Endpoints are paths, for the same reason `mm_parent` is a path.** In-memory ids are minted fresh every
load and must never be persisted. Edges whose endpoints don't resolve are dropped silently on load, so
deleting a note in Finder degrades the board instead of corrupting it.

**The frontmatter/board split has one rule:** frontmatter describes the NOTE; `board.json` describes the
BOARD's arrangement of it.

| stays in frontmatter | moves to `board.json` |
|---|---|
| `mm_type`, `mm_layout`, `mm_query` | position (`mm_position_x`/`_y`) |
| `mm_locked`, `mm_done`, `mm_checklist`, `mm_blank` | size (`mm_w`/`mm_h`) |
| `tags`, `color` | `mm_collapsed` |
| **`mm_parent`** — the deliberate exception | child order |

**`mm_parent` stays in the note deliberately.** By the rule above, membership is arrangement and belongs
in `board.json` — but two things outweigh that. A note that says "I belong to X" keeps the FOLDER
self-describing: lose `board.json` and you still have the entire hierarchy, just in filename order. And
a note has one `mm_parent` field, so **"a node has at most one parent" is unrepresentable-otherwise
rather than validated** — an `mm_children` list in the parent would let two parents claim the same child
and would need conflict resolution on every load, forever.

**Child order lives in `board.json`, because order IS position.** Today sibling order is literally
derived from position — `childOrder` (layout.ts) sorts children by `mm_position_x`/`_y` and clusters
them into bands. Removing positions removes the ordering, so order is the 1-D remnant of data already
moving to `board.json`. Keeping it in the notes as `mm_order` would rewrite every sibling file on every
drag of a single outline row.

**The child list in `board.json` is a SORT HINT, never a record of membership.** `mm_parent` is
authoritative. Entries that don't resolve are ignored; children whose `mm_parent` claims them but that
are absent from the list are appended, sorted by filename. The list therefore cannot lie about the tree
— at worst it is incomplete, and incomplete degrades gracefully.

**Two splits are arguable and were left where they are:** `mm_collapsed` (arrangement by the rule, but
per-note state a reader might expect in the note) and `mm_layout` on a frame (kept in the note because
it defines what kind of frame it is, not where the frame sits).

**Open risk — `board.json` is a hot file.** Every change touches it, so two devices editing over iCloud
or Dropbox conflict on the whole board where today they conflict on one note. Per-note frontmatter was
conflict-resilient by accident. Decide whether multi-device editing matters before this is baked in.

**The external-change watcher must watch `board.json`.** Otherwise an edge drawn on another device never
appears (`store/watch.ts`).

---

## Migration

**A legacy map must look IDENTICAL on first open.** Existing maps are full of card-to-card `mm_parent`
chains, which this change outlaws. On load:

1. Every card whose parent is a plain card becomes top-level, at the ABSOLUTE position it renders at
   today (`mm_position_x`/`_y` are parent-relative — resolve them before flattening).
2. Each former branch becomes a drawn edge.
3. Children of frames are untouched. `mm_type: stack` nodes become plain cards with children.
4. `mm_side` is read and discarded.

Nothing moves on screen; the tree quietly becomes a graph. What this costs is collapse on those groups,
so it is paired with a per-card **"Nest these inside"** action that converts a card's edge-connected
former children into contents. Migration is then lossless, invisible, and converted at the user's pace
rather than the app's.

**The help map is redone by hand**, not migrated — it is authored content and should showcase the new
model rather than carry a flattened old one.

---

## Rejected alternatives

**Two edge types with an "Attached" toggle** — one edge object carrying one bit that decides whether it
is structural. Elegant on paper, and it dies on the same objection that killed two line types: a user
who styles both identically can no longer tell which lines move their cards. Also nobody ships it.

**Two edge types, branches unselectable** — make branch lines unstyleable so "if you can click it, it's
a relation" becomes the discriminator. This works and is close to what the field actually does. Rejected
because it keeps the branch line carrying five jobs, which is the underlying problem.

**Infer hierarchy from position** — a card is a child exactly when it sits in the parent's slot. Too
magical: children carry authored positions, so "is it in its slot" has no clean answer, and tidying the
canvas would silently dismantle structure.

**`mm_children` in the parent instead of `mm_parent`** — puts hierarchy and order in one place. Rejected:
loses single-parenthood as a format guarantee, and moves write amplification the wrong way (create, move
and delete each touch two files, neither of them the file the user acted on).

---

## What this loses

Stated plainly, because it is a real trade and not a free win:

- **The radial mind map.** A hub with ideas radiating outward is not expressible. This is the change
  that makes the rename from "Mindmap" to "Corkboard" final.
- **Cross-level glanceability.** Children beside a parent let you see parent, children and siblings at
  once. Outline rows are more compact but flatter to read.
- **The default fast path for tree-building.** `Tab` (`addChild`) used to spread outward for free; it
  now nests inward. Building a deep tree quickly becomes a deliberate choice — which is fine, because
  an outline is a better tree-typing surface than branches ever were, but it is a change in feel.


---

## Implementation status

**Stage 1 — `board.json` (DONE).** `data/board.ts` owns the file: edges, ink layer and per-map view
prefs, with its own debounce. It absorbs `sketch.json` and `settings.json`, which are still READ when
there is no board file yet and never written again (nothing deletes them). `exportZip` packs it;
`importFiles` carries it over. Verified: written, read back, settings survive a reload, an older vault
still opens.

NOT yet moved here, deliberately: node GEOMETRY (position, size, `mm_collapsed`, child order). Those
stay in frontmatter until stage 3, where the position semantics change anyway — moving them earlier
would be two migrations of the same data.

**Stage 2 — edges as objects (DONE, minus styling UI).** `core/state.ts BoardEdge`,
`view/free-edges.ts` (geometry + paint), `features/edge-tools.ts` (interaction). Working and verified
end to end: four hollow sockets on a selected card, socket-drag to another card, `⌘L` on a
multi-selection, click to select, endpoint handles that re-route or detach, Delete, hidden when either
end is hidden, persisted by path and resolved back on load. Drawing an edge moves nothing.

**The edge's floating menu is DONE** (`features/edge-bar.ts`): colour · solid/dashed · direction ·
delete, anchored to the curve's own midpoint (the quadratic's, not the chord's, so it sits ON the line
it edits) and tracked across pan/zoom by the same kind of rAF follow loop the card bar uses.

It is a SEPARATE bar rather than a mode of `features/float-bar.ts`. That one is keyed on `state.sel`
and anchored to a CARD from end to end — anchorNode, labelRect, the locked-selection collapse — and an
edge shares none of its controls; folding two unrelated control sets into one component would cost
more than the shell it saves. It wears the same chrome, so the two still read as one idea, and they
can never both be open (selecting either clears the other).

The label is drawn on the curve on a background-coloured plate so the line doesn't strike the text
through, and its width is ESTIMATED from the character count rather than measured — the SVG is rebuilt
on every paint, and a real measurement would cost a layout flush per edge per frame.

One bug this surfaced and fixed: `serializeEdge` omits each field that equals a fresh edge's default,
but `dashed` defaults to TRUE, so omitting `dashed: false` read back as dashed and a SOLID edge could
never be saved. The writer now omits the dashed case and writes the solid one.

**Edges are in the UNDO HISTORY** (`touchEdges`, features/history.ts), as a fourth thing a step can
carry alongside node images, the ink layer and the canvas colour. They are snapshotted WHOLESALE
rather than as keyed before/after images like nodes: there are few of them, they are small, and an
edge has neither of the two problems that shape the node model — its id is persisted, and there is no
resurrect-vs-update distinction to make.

**One timeline, not two, and deleting a CARD is why.** `deleteNodes` now prunes every edge touching a
removed node, inside the same step. Left unpruned, such an edge is already invisible (`edgeVisible`)
and unsaveable (`serializeEdge` drops it), so it would linger in memory until the next save quietly
ate it — and worse, undoing the delete would bring the card back with nothing attached. One ⌘Z now
restores the card and its edges together.

**A label is one step per editing SESSION, not per keystroke** — the before-image is taken when the
field takes focus and the step closes on blur, the same shape inline card editing uses. Every other
control (dash, arrows, colour) closes its own step per click, and drawing, deleting and re-routing
each close one. `⌘L` on a multi-selection is a single step for the whole chain, since it was one
command.

`applyStep` restores the edge list before the repaint (like the canvas colour, so one pass does it),
drops `state.selEdge` if the step removed the selected edge, and re-syncs the edge bar — so undoing a
label edit puts the text back in the field, and undoing a delete closes a bar pointing at nothing.

Verified: delete an edge → ⌘Z restores it with label and arrowhead → ⇧⌘Z removes it again; delete a
CARD → ⌘Z brings back both card and edge; type into a label, blur, ⌘Z reverts the whole edit at once
and the field re-syncs; toggle dashed → ⌘Z restores both the line and the bar's icon.

**Stage 3 — containment (PARTLY DONE).**

Done and verified in the app:

- **A card with children is the outliner.** `isStack` / `insideStack` (view/layout.ts) key on *having
  children* instead of on `mm_type: stack`, plus `hasRows` so an annotation-only child doesn't make a
  container. The whole existing outline machinery then applies to every card, unchanged.
- **The `stack` KIND is gone.** `NodeType` is card | frame | annotation | query; `foldTypeLayout`
  folds the legacy `mm_type: stack` and the older `mm_layout: stack` to a plain card. The float bar
  drops the Stack chip, and a card now offers NO arrangement chips at all — `line`/`fan`/`free` placed
  children beside the parent, which this model has no room for.
- **Branch edges are gone for free.** paintEdges already skips a container's children, so making
  every card-with-children a container removed the connectors without touching edges.ts. Annotation
  tethers are unaffected — an annotation is pinned to its parent, not outlined by it.
- **`mm_side` left the FILE FORMAT.** Dropped from `parseMd`/`serializeMd`, from the parsed shape,
  from the load-time backfill and from the clipboard. Since `serializeMd` strips every `mm_*` and
  re-emits only what it writes, the key disappears from each note on its next save; the loader
  already ignores it. Behaviour-neutral — `sideOf`/`deriveSide` still derive on demand.

**The flatten migration is DONE** (`flattenLegacyBranches`, data/persistence.ts). A map is legacy when
`board.json` is missing or its `model` is below `BOARD_MODEL` (2) — the marker turned out not to need
the geometry move at all, so it landed early. It runs once, after the top-down pass has settled every
node's absolute x/y, and re-anchors each flattened card against its nearest FRAME (or the world),
recomputing `rx`/`ry` so the note writes back exactly where it renders.

The four exclusions, each verified against a fixture holding one of them: a legacy STACK's children
stay nested; a FRAME's children stay put; anything under a COLLAPSED ancestor stays nested (making it
top-level would pop a hidden subtree onto the canvas — left alone, a folded branch looks untouched and
expands into the new outline); an ANNOTATION keeps its parent.

**The write order is board-first and awaited.** The new edges and the model stamp must be on disk
before any note loses its `mm_parent`, or a failure between the two would drop the hierarchy AND the
edges meant to replace it. If the board write throws, the notes are left alone and the map migrates
again next time — the conversion is a pure function of what is on disk.

Verified end to end: a branch of Root→Kid1→Grand plus Root→Kid2 flattened to four top-level cards at
their original absolute coordinates joined by three drawn edges, nothing moved on screen, `board.json`
stamped `model: 2`, and two further reloads produced no duplicate edges and no further conversion.

**The geometry move is DONE.** `board.json` grew a `nodes` map keyed by path: `x`/`y` (keeping exactly
the meaning `mm_position_x/y` had, so nothing in the layout pipeline changed), `w`/`h` under the same
authored-size rule as before, `collapsed`, and `order`. `serializeMd` no longer writes any of them;
`parseMd` still READS them, and the loader prefers the board file and falls back to frontmatter, so an
older vault opens unchanged and each note sheds the keys on its next rewrite.

**Child order rides the `kidOrder` array that already existed** in memory (view/layout.ts orderedKids),
which was seeded from positions and mutated by drags but never persisted. Storing it as paths turned
out to need no new reconciliation: `orderedKids` already drops ids it can't resolve and appends
unlisted children by position, which IS the sort-hint contract. Verified by hand-editing the order in
`board.json` and reloading — the rows swapped. An earlier attempt at the same test silently did
nothing because the file had been renamed underneath it, which demonstrated the drop-and-append path
just as well.

**`commitRel` now flags `dirtyLayout`, not `dirty`.** It marks a node whose stored offset went stale
when its PARENT moved; that used to mean "rewrite the note", and after the move it must mean "rewrite
the board". Leaving it alone would have written a .md on every drag to change nothing in it — which is
how it was found. Two consequences: moving a card now touches exactly one small JSON file and no
notes, and the stray "Saved 1 file" that fired on EVERY load of a map with an outline (present on
`main` too) is gone — a load of a settled map now reports "Saved 0 files".

`saveAll` writes a note on `dirty || !file` only; `scheduleSave()` also schedules the board, so the two
files settle together. `exportZip` always packs `board.json` now — without it a zip would unpack as a
pile of notes with no layout. `flushBoard` calls `commitRel()` itself, since it has its own debounce
and cannot rely on `saveAll` having run first.

**`side` is GONE**, and it took more with it than "dead code" implied — several call sites needed a
decision, not a deletion:

- `MindNode.side`, `LayoutSide`, `sideOf`, `deriveSide`, `SIDE_RANK`, `orderAxisIsX`, `reorderTarget`,
  `ui.dropSide` and `edgeFromUV` are all deleted, along with the `line`/`fan` side-bucket layout in
  `layoutSubtree` and its two spacing constants.
- **`dropLanding` lost its `side` argument and its geometric shortcut.** It used to place a card up /
  left / right / below the target for a "free" governor. A card governor outlines now, so there is no
  shortcut to take — it always simulates and lets the outliner say where the row lands. The subtlety:
  the governor is often still CHILDLESS at that instant and only becomes a container once the dry run
  hands it the dragged card, which is exactly why the estimate can't be made before the simulation.
- **`kidsByPosition`'s fallback** (a free frame's children — the one branch the side buckets really
  served) is now reading order off the subtree-box midpoint: top to bottom, then left to right.
- **`view/edges.ts` is down to annotation tethers.** The parent→child connector geometry, all three
  edge styles, the side sockets and the reparent-preview ghost edge were all reachable only through
  branches that no longer exist. What survives is the dotted line from an annotation to the card it
  comments on, which was never a branch.
- **The outline view's `reorderBucket` became `reorderSiblings`.** It used to splice `kidOrder` AND
  re-pack the bucket's subtrees along an axis, because order was encoded in position and would
  otherwise be re-derived away on the next load. Order is stored now, so the splice is the whole job.

Verified after the removal: Tab still nests a child inside its parent as an outline row, the outline
view renders and the tree is intact, board.json still records order (and self-corrects a stale key
after a rename), a settled map reloads reporting "Saved 0 files", and the console is clean.

NOT verified: **drag-and-drop nesting** (dragging one card onto another). The harness's synthetic drag
does not emit enough pointer-move events to drive `updateDropTarget` — instrumenting it showed the
resolver never runs, so the card just repositions. That is a test-harness limit rather than an
observed defect, but it means `dropLanding`'s new always-simulate path and the reworked drop
resolution have only been checked by the type system and by reading. **Drag a card onto another card
by hand before trusting this.**

Still outstanding:

- The `line`/`fan`/`inherit` values in `NodeLayout`, now unreachable for cards.


---

## Follow-ups after first use

Five changes once the edges were real enough to live with:

- **Ports are stored, not derived** (`EdgeSide`, `edge.fromSide`/`toSide`, persisted in board.json).
  Backfilled ONCE for an edge saved before they existed, from where its cards sit at that moment —
  the same "backfill once, never re-derive" shape the old `mm_side` had, and for the same reason.
- **Routing is orthogonal** and port-aware: a stub out along each port's normal, then a single
  dog-leg. `view/free-edges.ts routeFor` returns the POLYLINE as well as the path `d`, which is what
  lets the arrowheads take their angle from the real last leg and the label and the bar sit at the
  midpoint BY ARC LENGTH instead of at a separately-guessed point.
- **The label is edited in place on double-click**, not in a field on the bar. One undo step per
  editing session; Escape cancels (the field stops the key reaching the canvas), Enter and blur commit.
- **The colour chip is the shared round `.swatch`**, the same object the card bar shows. This needed
  `#edgeBar button:not(.fb-swatch)` on the reset rule — a blanket `all:unset` had been stripping the
  round face and the `--sw` background off it.
- **Direction is a three-chip popover** using the same `.layoutchips` idiom as the card bar's type and
  layout choosers.

Two bugs found while testing these, both in code written earlier the same day:

- `#ebLabelEdit` showed up on load: `all:unset` was declared AFTER `display:none` and reset it. It has
  to come first.
- Double-clicking an edge did nothing: the pointerdown handler called `preventDefault()`, which
  suppresses the click/dblclick the browser would otherwise synthesise. `stopPropagation()` alone is
  enough to keep the canvas from panning.


---

## Second round of follow-ups

- **A selected edge wears a RING, not a recolour.** Its own path, drawn thicker and solid underneath
  it in `--node-sel` — the same token and the same idea as a card's 2px ring. Solid deliberately: a
  dashed edge's ring has to be continuous or the outline reads as merely more dashes.
- **The target card's ports light up as you come in to land.** All four hollow, the one about to be
  taken filled. `nodeNear` uses a generous 70px so the preview appears while there is still time to
  aim somewhere else — and `finishDraw` now uses the SAME test, so what the preview promised is what
  the drop delivers.
- **Clicking empty canvas deselects an edge.** The listener was on `#world`, which is a transform
  origin with NO SIZE of its own (its rect is 0×0), so a click on bare canvas never landed inside it
  and was never heard. Moved to `#stage`, the full-viewport surface that contains everything.
- **Several edges may join the same two cards**, as long as they don't take the same two PORTS.
  "blocks" one way and "informs" the other is an ordinary thing to want to say. What is still refused
  is a second edge between an identical port pair — it would lie exactly on top of the first — and
  that selects the existing one instead. Direction is part of the identity: A.right→B.left and
  B.left→A.right are the same physical line.
- **Edges track their cards live.** `paintEdges` now paints the tethers AND the free edges, because
  every one of its dozen callers wants both — the drag frame loop, the auto-pan loop, the layout
  animation. Pairing them at the single definition is what stops the next repaint site forgetting the
  second call.
- **Dragging the LINE re-routes it**: the half you take hold of is the end that comes loose, and
  releasing with no card near enough to dock to removes the edge. It is the gesture the shape already
  suggests — an edge looks like string between two pins, so pulling one half lifts that end off its
  pin. Armed rather than started, so a press that never moves is still just a selection and a
  double-press is still a label. The endpoint handles remain the precise version.


### Line defaults, third pass

- **Stroke width 4**, matching an annotation's tether (`.anno-edge` takes it from `svg#edges path`).
  Every line the app draws on the canvas is now the same weight, so an edge reads as one of the family
  rather than as a hairline. The selection ring widened to 8 to keep 2px showing either side, the same
  as a card's.
- **Solid by default.** `makeEdge` starts an edge solid; dashed is a choice.
- **`dashed` is now written to disk ALWAYS**, breaking the omit-when-default rule on purpose. Its
  default has already flipped once, and an omit-when-default boolean silently inverts every stored
  value the moment that happens — it cost a bug in each direction (a solid edge that came back dashed,
  then the reverse). A few bytes buy immunity from the whole class.
- **The line stops at the arrowhead's CENTRE, not its tip.** At stroke-width 4 a stroke run to the tip
  pokes through the point and reads as a blunt spike. Done by nudging the terminal the route aims at
  outward along that port's normal by half the head's length — the arrowhead keeps the true port as
  its tip. Applied at the routing input rather than by trimming the finished path, so the straight and
  bezier styles get it for free.


### Drawing feedback, and the arrowhead settling down

- **The draft IS the edge, not a ghost.** Mid-draw the line is drawn in its final stroke, colour,
  dash and arrowhead. A preview wearing a costume of its own asks the user to translate; this one is
  simply the edge, already where they are putting it.
- **The edge being re-routed is hidden while it is being moved.** Drawing it in its old place as well
  made one edge look like two.
- **AIMING and SNAPPING are separate, with separate radii.** A card within 70px shows all four of its
  ports so there is something to aim at; the line only snaps when the pointer has actually reached
  within 20 SCREEN px of one (divided by the zoom, so it feels the same however far out you are).
  Before this the line lunged at a card from halfway across the canvas — it was making the docking
  choice on the user's behalf, far too early. `portSnapAt` is the single spelling of the question, so
  the live preview and the drop can't disagree; and "released without reaching a port" is now a
  precise condition, which is what the delete-on-release rule needed.
- **The arrowhead's two axes are set separately**: 18 across, 9 along. Width is what makes a head
  readable at a glance; length past a point just makes it a dart. Wide and shallow reads as an arrow,
  long and thin as a spike.
- **The line runs all the way to the TIP.** A filled head had to be inset by half its length or the
  stroke poked out through the point; an open head has no interior to poke out of, and the shaft
  meeting the tip is what makes the two read as one arrow rather than a line near a chevron. The
  inset is gone entirely.


### Routing, annotations, and a selection that holds several lines

- **One turn beats three.** Whenever the two ports can be joined by a single bend, they are: the
  corner sits at `(b.x, a.y)` or `(a.x, b.y)`, and the line arrives at each end already travelling
  along that port's normal. It applies only when the two ports face different AXES (two ports on the
  same axis always need a dog-leg) and only when the corner is at least a stub's length ahead of
  both — a bend right against a card's face reads worse than the Z it replaced. Everything else falls
  back to the old stub-dog-leg-stub route unchanged.
- **A double-click on a line opens its label — counted by hand, not by `dblclick`.** The FIRST click
  selects the edge, which repaints `#freeEdges` wholesale, so the element the second click lands on is
  not the one the first did; Chrome, finding no common target still in the document, dispatches no
  `dblclick` AT ALL. (The same hazard `main.ts`'s node cache documents.) Two presses on the same edge
  within 450ms and 6px are counted in the pointerdown handler instead. That press is also the one
  place `preventDefault` is called: the label field is focused two lines later, and the press's
  default action would move focus straight back out — a blur commits and closes, so without it the
  editor opened and shut in the same tick. Touch gets the gesture for free: a double TAP opens a
  label, and iOS never has to synthesise anything.
- **An annotation has exactly ONE line, to its parent.** It shows no rings, refuses a drop, and any
  free edge that touches one stays hidden (`connectable`, `edgeVisible`). An annotation is a note
  pinned to a card, and its dashed tether says the whole of that; ports as well would offer two
  different ways to attach the same sticky note, one structural and one not — the exact confusion
  containment exists to remove.
- **A ring already carrying an edge is FILLED.** The same fill the draw preview uses for the port it
  is about to take, and for the same reason: filled means "a line is on this one". So a selected card
  says at a glance which of its four faces are spoken for — what you want to know before dragging a
  second line off the same side.
- **The edge selection is a SET** (`state.selEdges`), ⌘-click toggling members exactly as it does for
  cards. Cards and edges still never share a selection: `applySelection` clears the edges whenever a
  card selection exists, at the one funnel every card-selection path runs through. The bar acts on the
  whole set and sets one VALUE across it rather than toggling each edge's own — three lines where two
  are dashed become three dashed lines. The LEAD edge (the last one clicked; `selEdges` is a Set, so
  insertion order gives it for nothing) is the one the bar hangs off and reads its buttons from, so a
  control does what it looks like it will do. Endpoint handles show only for a selection of one: on
  several they are identical dots with no way to tell which line each belongs to, and the gesture they
  offer is single-edge by nature.
- **A frame's ports sit on its BOX, not its bounds.** A frame's bounds include the title tab hanging
  above the box, so a port on the bounds' top edge landed up on the tab — or in the empty gap beside
  it. `portRect` is the one place the port geometry is spelled (`elTop`, the same shift the annotation
  tethers already used), so a port, its ring and the side a drop picks cannot disagree.
- **The pickers are menus, not second bars.** Type, layout and arrow chips run DOWN the popover, and
  the colour pickers wrap at four — a small block taken in at a glance rather than a strip of
  thirteen to be scanned. The popovers size to their content and wear the panel radius instead of the
  bar's pill. (`.layoutchip` also lost the generic button padding it was inheriting, which had been
  squeezing a 21px glyph into 8px in the arrow picker.)


### Two ends, and a label that can be read

- **Each END of an edge wears its own CAP: none, dot or arrow** (`fromCap`/`toCap`, replacing the
  single `arrows: none|to|both`). "A dot here, an arrow there" is an ordinary thing for a diagram to
  say, and one three-way axis could not say it at all. A `dot` is the terminator that marks an
  endpoint without claiming a direction. Defaults are unchanged in effect: bare at the source, an
  arrowhead at the target.
  - The migration is a READ, not a rewrite: an edge stored with the old `arrows` maps exactly
    (`none` → bare/bare, `to` → bare/arrow, `both` → arrow/arrow), and the next save writes caps and
    drops the old key on its own. Nothing has to be migrated eagerly, and an old board file opened by
    an old build still works.
  - The picker is TWO columns, one per end, each a column of the same three chips — two ends are two
    questions. It stays open after a pick, since setting both otherwise means reopening the same menu.
    Each chip is a small picture of the result: the cap drawn at its own end of a short line, with the
    shaft shortened to make room exactly as the real edge does it.
- **A label's ink is DERIVED from the canvas fill**, black or white, by the same `inkFor` a frame's
  title goes through (`canvasSurface`, the end of `behindFill`'s walk). The theme's own `--fg` was
  right only while the canvas wore the theme's own `--bg`; on a coloured map, or inside a coloured
  open frame, it was ink chosen against a surface that isn't there. The plate is painted in that same
  fill, so the label reads as a small patch of canvas laid over the line.
- **Recolouring the MAP now repaints the free edges too.** It used to touch nothing but the background
  — that stopped being true the moment a label's ink came from the fill. Still not `paintAll`: the
  background and the edges are the whole of what a map colour reaches, and this runs once per pointer
  move over the native colour sheet.

- **A label sits on the line the STYLE actually draws.** `pts` is the route's polyline, which for the
  bezier style is the CONTROL polygon — right for the two end tangents (its first and last legs ARE
  the tangents there) and wrong for the middle, which is out in the bay the curve bends away from.
  So a style whose path isn't its polyline hands the midpoint over explicitly (`routeFor`'s optional
  `mid`; the cubic at t=.5), and everything that hangs off the middle — the label, the bar, the inline
  editor — follows one point. Measured on a real curve: the label sits 0.75px off the path, against
  the tens of pixels it used to float.
- Label text is 12.5px (was 11) — it is read at a glance while the eye is on the diagram, not studied.
- **An end DOT rides the overlay ABOVE the cards; an arrowhead stays with the line.** A dot is centred
  ON the card's border, so drawn behind the cards the card swallows half of it. An arrowhead's body
  lies outside the border and has no such problem. Never a click target — the line under it is what
  you grab.


### Nesting a card by dropping it on another

- **A reparent is a NOTE write, not a board write.** `mm_parent` lives in the note's frontmatter, so
  `reparentOnly` (and the rip-to-root path, and the outline's "make root") must set `dirty` as well as
  `dirtyLayout`. They didn't after geometry moved to `board.json`: the new parent showed on screen,
  nothing reached disk, and the next load put the card back where its file still said it was. The
  ORDER among siblings is genuinely the board's, so both flags — one for the link, one for the slot.
- **Dropping onto a childless CARD previews an insertion bar at the card's bottom edge**, not a
  landing ghost. The drop makes that card an outliner and the dragged card its first row, so the bar
  is the honest preview: it says where the row goes, and that the target is about to hold rows at all.
  Inset by the stack's own padding, so the bar is exactly as wide as the row it stands for. A target
  that ALREADY has rows never reaches this branch — the stack branch owns it, with the bar in the gap
  the cursor is actually pointing at.
