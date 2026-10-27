# Possible improvements

Found in a whole-project review (October 2026) and deliberately left for later: each is a change of
its own, not a cleanup. Nothing here is a known bug. Line numbers drift — search for the names.

## Speed — matters most on big boards

- **Rubber-band selection repaints the whole board on every mouse move.** `features/gestures.ts`
  calls `setSelectionSet` per pointermove, and the hit test reads every card's height straight after
  the writes. Better: take every card's box once when the drag starts, and toggle the `sel` class only
  on cards that changed; set the real selection once, on release.
- **The selection toolbar measures every selected card on every frame**, even when nothing moves
  (`features/float-bar.ts` `followLoop`: two `getBoundingClientRect` per selected card). After ⌘A on a
  big board that is thousands of reads a frame. Better: the selection's box from `n.x`/`nodeW`, mapped
  through the view, re-placed only when the view, the selection or a drag changes; stop the loop when idle.
- **Dragging rescans every card for smart guides on each move** (`features/guides.ts` `neighbours`)
  and redraws every line (`view/free-edges.ts` `paintFreeEdges`). Better: snapshot the sibling boxes at
  drag start; batch the work into the drag's animation frame; redraw only lines touching the moved cards
  (one `<path>` per line, keyed by id).
- **Finding a card's children scans the whole map** (`utils/model.ts` `childrenOf`), so `subtreeIds`,
  `descendantCount` and `subtreeHasLocked` are O(subtree × cards). Hot callers: `paintNode` on folded
  frames, a card press after ⌘A, `settleFrames`. Better: a parent → children map built once per
  operation, or kept on `state` and updated on reparent/add/delete.
- **With a folder map, every switch back to the window re-reads every file**
  (`data/persistence.ts` `reloadFromDisk`). Better: compare each file's `lastModified`/size with the
  last load and skip the reload — or reload only what changed — when nothing did.
- **`paintNode` redoes text work on every paint**: the card's markdown, its task count and the search
  tags; a clipped card reads `offsetTop`/`getComputedStyle` mid-paint, forcing a layout per card.
  Better: cache the text-derived values on the body string (as `noteTags` does) and do the clip reads
  in a pass after all writes.
- **`remeasure()` paints twice** although `applyLayouts` now only prunes the scope. Have
  `applyLayouts` say whether it changed anything and skip the second paint when it didn't.
- **An autosave plans paths twice** (`planPaths`, a sort with an ancestor walk in its comparator) and
  writes/removes files one at a time — slow when renaming a frame moves every note in it. Reuse the
  first plan; write with a small concurrency cap.

## Structure

- **Collect the "busy" tests in one place.** `features/peek.ts` and `features/float-bar.ts` each spell
  "drag, pan, pinch, marquee or an editor" and partly read it back off body classes. One `isBusy()` in
  `core/ui-state.ts`.
- **Let paintNode emit kind classes** (`box`, `chip`) instead of CSS rebuilding them with
  `.node:not(.frame):not(.image-card)` and `.collapsed:not(.image-card)` chains.
- **`n.dirtyLayout` is written in ~20 places but read only right after a load.** A load-local flag
  would do, and the field could go.
- **The paintNode branch that nests a card inside a parent CARD** looks unreachable (cards never hold
  cards since the load migration); verify against an old map, then delete.
- **`ensureResizeHandles` always gets `FRAME_DIRS`**, and history's `EdgeGraph` is a one-field wrapper
  around `BoardEdge[]` — both can shrink.
- **Swallowing the click after a tag drag** uses `dataset.dragged` + `setTimeout(0)` checked in each
  click handler; a one-shot capture-phase click listener (`swallowNextClick` in `utils/dom.ts`) would do
  it in one place. Likewise the tag tray restores itself from a module-level `setTimeout` instead of
  from main.ts's setup sequence.
- **`animateReflow` parks the frame content wrapper with raw `style.left/top`**; it would be safer if
  `placeSelf` placed a frame's wrapper along with its box.

## Needs a decision first (changes behaviour)

- **One "can this card take a drop" test.** `features/image-extract.ts`, `features/drag.ts`,
  `features/attachments.ts` and `canMerge` (`features/crud.ts`) disagree about image cards and folded
  frames. Pick the rule, then share it.
- **`growFramesToHold` skips the hidden-frame check** that `collectsCards` makes.
- **The line toolbar's popovers clamp to the window by hand** (`features/edge-bar.ts`) instead of
  `placeInViewport`, so they ignore the notch/home-indicator safe areas.
