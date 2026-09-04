# Spec — goo groups

**Status: DECIDED, NOT IMPLEMENTED.** Brainstorm outcome of 2026-09-04. Same conventions as
[spec-edges-and-containment.md](spec-edges-and-containment.md): topics findable by their **bolded lead
sentence**, symbol names are the contract. Until implemented, [architecture.md](architecture.md) and
[CLAUDE.md](../CLAUDE.md) describe the app; this describes the intent.

## Why

Frames are boxes you draw first and fill later. Most groups on a corkboard happen the other way round:
cards drift together because they belong together, and only afterwards does the cluster deserve a name.
The reference feel is World of Goo: things stick when they come close, snap with a little overshoot, and a
cluster reads as one soft body you can pick up whole.

## The model in three sentences

**Nearby cards form a FRAME, and a frame is drawn as the goo hull of its children.** Proximity creates the
frame, distance dissolves it, and the hull has no size of its own. Dragging the hull moves everything
inside; dragging a card across the hull's edge moves it in or out.

---

## Decisions

Each was a question with alternatives; the alternatives are under "Rejected" below.

- **A group IS a frame** — a node with `mm_type: frame`, its members are its `mm_parent` children. Nothing
  new in the file format. Title, colour, collapse and history come for free.
- **Frames become blobs, and the two other frame faces go.** `mm_layout: tabs` folds to a plain frame on
  load (`foldTypeLayout`), and opening a frame (the canvas IS its interior) is retired. One concept.
- **A frame's bounds are DERIVED from its children.** `mm_w`/`mm_h` are no longer read or written for
  frames (still the file format, still honoured for `query` and image cards). An empty frame cannot exist
  except transiently. There is no empty interior to drop into: dropping NEAR is the gesture.
- **Joining is automatic, by the BUBBLE, during the drag.** A card whose rect overlaps a frame's resting
  hull (`hullGap` = 0) becomes a member — anywhere in the goo, not only next to another card; the hull
  grows to include it while the pointer is still down. Leaving needs `LEAVE_GAP` clear of the hull's edge
  (hysteresis, no flicker). No magnetic snap: the card stays exactly where the pointer put it.
- **Two loose cards touching CREATE an untitled frame** around both, at the top level only: siblings
  inside a frame sit close by design, and nudging them must not mint frames.
- **Frames NEST by the same rule** (revised 2026-09-04, was "frames only bump"). A frame dragged into
  another's bubble becomes its child, its hull box standing in for a card's rect; the deepest bubble a
  dragged node overlaps wins. A card pulled out of an inner frame lands in the enclosing one, not at the
  top. A nested untitled frame's wash deepens one step from its parent's.
- **A frame dissolves when it is down to one child**, unless the user authored something on it (a title,
  a colour, tags, body text). Symmetric with creation; `dissolveEmptyTabGroups` in `crud.ts` is the
  precedent and gets generalised.
- **Proximity always means "group as siblings".** A loose card next to an outliner (a card with children)
  makes a frame around both. Becoming a child ROW stays a drop ONTO the card. Annotations do not group.
- **The hull is a tight metaball union**: one rounded rect per child plus smooth necks between neighbours.
  Cards far apart inside one frame show a thin bridge, which is the honest picture. Pure SVG paths, no
  raster `feGaussianBlur`: crisp at every zoom, exportable.
- **The title is a label inside the hull padding**, top-left, part of the fill. Untitled frames show none.
  The title tab and its bounds arithmetic ("A `frame`'s BOUNDS include its title tab") go away.
- **An untitled frame is a neutral canvas tint** until a colour is authored via the palette. Ink and
  scrim derive from the fill as for every node (`utils/ink.ts`).
- **Folded frame = one small blob** carrying the title and the existing `.hidden-count` chip. Children hide
  through `isHidden`, the one gate, unchanged.
- **Ports go away. Edges are drawn in a CONNECT MODE** toggled from the toolbar (and a key). In it,
  dragging from any card or hull to any other draws an edge; nothing moves. Outside it, no rings, no
  handles except on a selected edge.
- **An edge docks at the nearest point of the target's outline.** `side` stays in `board.json` for
  compatibility but is no longer read; `portPoint`/`nearestSide`/`resolveSide` retire.

## Hull geometry

**The hull is computed on paint from the children's rects, never stored.** Per frame:

1. Take each direct child's rect (a nested frame contributes its own hull's bounding rect), pad by
   `HULL_PAD`, corner radius `HULL_R`.
2. For each pair whose padded rects are within `NECK_GAP`, add a neck: two cubic Béziers tangent to both
   rects across the gap (the metaball construction of Hiroyuki Sato / Varun Vachhar, adapted from circles
   to the nearest straight edges of two rounded rects).
3. Emit rects and necks as ONE `<path>` in a per-frame `<g>` on a new SVG layer under the cards (the
   `#freeEdges` layering in `free-edges.ts` is the model). Same fill everywhere, so overlaps merge for
   free; a `drop-shadow` filter on the `<g>` shadows the union silhouette.
4. The frame's derived rect (`nodeW`/`nodeH`) is the path's bounding box. `placeSelf`/`elTop` unchanged.

Only the frame currently being changed re-emits its path per frame; static frames keep theirs.
Attach and detach animate: CSS cannot transition a path's `d`, so the neck's control points are tweened
in JS for ~250ms with a spring curve (slight overshoot, the World of Goo snap) and the path re-emitted per tick.

## Interaction

- **Hull hit area is the padding ring only**: the interior between cards belongs to the canvas, cards to
  themselves. Pointer-down on the ring starts the frame drag (`bindNodeDrag` on the `<path>`), which moves
  all descendants as today.
- **Membership is evaluated in `feedDragMove`** against siblings of the dragged node's parent and against
  the parent's own hull edge. Crossing `LEAVE_GAP` outward calls `reparentOnly` to the grandparent; crossing
  `JOIN_GAP` toward a sibling frame calls `reparentOnly` into it; toward a loose sibling card creates the
  frame (`createNode` + two `reparentOnly`) and continues the drag as a member. Every step is one history
  entry so a single undo restores the pre-drag world.
- **Read-only and demo mode**: hulls render, membership never changes (writes are no-ops, and the drag
  itself is refused as today).
- **Touch**: same thresholds in WORLD units, so a pinch-zoomed iPad keeps the same feel.

## Storage and migration

- Nothing new on disk. `mm_w`/`mm_h` on existing frames are ignored on load and dropped on the next save
  (`serializeMd` rewrites app-owned keys). `mm_layout: tabs` folds to a plain frame.
- Existing empty frames load, show as a small titled blob, and dissolve on first save if untitled and
  unauthored.
- `board.json` edges keep `side`; readers ignore it.
- URL hash for an opened frame (`nav/url-state.ts`) resolves to selecting that frame instead.

## What this loses

- Reserved empty space inside a frame ("drop here later"). Mitigation: a card dropped near a hull joins it.
- Tab groups. Their maps become plain frames with the former tabs as children side by side.
- Opening a frame as a focused canvas. The open-card scope (an opened CARD is its note) is untouched.
- Stable edge endpoints: docking at the nearest outline point means an edge slides as cards move.
- Frames nesting by proximity. Deliberate drop-onto remains.

## Rejected

- **Derived groups with no file** (connected components of touching cards, never persisted). Purest, but no
  title, colour or fold, and the user wanted all three.
- **Group as `board.json` arrangement**, like free edges. A group that means nothing structural rots.
- **Join on drop only, or via ⌥-drop.** Safer, less alive. Hysteresis is the accident guard instead.
- **Authored frame size as a minimum** under the hull. Two sources of truth for one rect.
- **Frames merging or nesting on contact.** Too much happens from a nudge.
- **Soft convex bubble hull** (Bubble Sets). Calmer, but a wide frame becomes a large empty oval.
- **Held-modifier or single-connector-dot edge drawing.** Invisible on iPad, or chrome kept.
- **Raster goo filter** (`feGaussianBlur` + `feColorMatrix`). Smears at zoom, needs a text layer split.

## Open questions

- `JOIN_GAP`, `LEAVE_GAP`, `HULL_PAD`, `NECK_GAP`, `HULL_R` values: start at 16 / 48 / 14 / 24 / 18 world px
  and tune in the browser.
- Whether a frame's label is inline-editable in place (probably yes, via the existing edit path) or through
  the properties panel only.
- Whether the hull path should also render a faint outline in the light theme, where a tint alone may be
  too quiet.
- How selection reads on a hull: ring around the union silhouette (`stroke` on the same path) is the
  obvious answer.

## Implementation order

1. **DONE** — `view/hull.ts`, painted from `paintEdges` so drags carry it; `<svg id="hulls">` under the
   cards; a hulled frame hides its box, tab, ring and handles (`.hulled`), selection is a stroked copy
   of the hull. Diagonal-only neighbours get no bridge yet (`ponytail:` note in hullPieces). Tune the
   look: PAD / R / NECK_GAP / NECK_MIN / LABEL_H at the top of the file.
2. **DONE (minimal)** — `fitFrame` in `view/layout.ts`: a frame with children takes the padded union of
   them as its box every layout pass; an EMPTY frame keeps its authored size. `mm_w`/`mm_h` are still
   written (derived values, harmless). Tab groups, opening a frame and frame resize are NOT retired yet.
3. **DONE (on release, not mid-drag)** — `updateDropTarget` resolves membership when nothing is under the
   pointer: the deepest frame whose resting hull the dragged card or frame overlaps (`hullGap`, hull.ts)
   takes it; a member leaves once `LEAVE_GAP` clear of the hull (`insideContainer`), and while still inside an
   outer bubble lands there. A card within `JOIN_DIST` of a loose TOP-LEVEL card sets `drag.near`, and the
   release mints an untitled frame around both. `dissolveThinFrames` (crud.ts): an EMPTIED frame always goes,
   an unauthored one already at 1 child. The hull previews all of it during the drag (`hullKids` counts the
   poised node, drops the ripping one). Deferred: live commit mid-drag with hysteresis.
4. Connect mode and nearest-outline docking; remove ports.
5. Docs: update CLAUDE.md invariants and the frame deep dives in architecture.md.
