---
date: 2026-07-02
tags: []
mm_parent: 🎨 Style & layout.md
mm_side: right
mm_x: 520
mm_y: 209
mm_collapsed: true
---

# 📐 Layout modes

**Any card can be made wider** — drag its left or right edge. Handy when a long title or note wraps
into a tall, narrow card: widen it and the text re-flows, so the card gets shorter. The height always
follows the content, and a card never goes narrower than the standard width. Notes pinned to a card
stay with the border they sit on as it moves.

Set how a card arranges its children (side panel chips):

- **Inherit** — use the parent's layout (default).
- **Free** — children stay exactly where you drag them.
- **Line** — children chain one after another.
- **Fan** — children spread out on whichever side you place them.
- **Frame** — the card becomes a resizable box (drag any edge or corner). Drag any card **into** it to hold it — the card travels with the frame; drag it back **out** to release. **Auto-size** (`⇧ A`, or the right-click menu) shrinks a frame to fit its contents.
  - Its name sits on a **tab above the top-left corner**, like a folder: click the tab to select the frame, double-click it to rename, drag it to move the frame. Dragging inside the box instead rubber-band-selects the cards it holds. A long name is shortened on the tab — hover it to read the whole thing.
  - **Folding** a frame (the round button on its tab corner, or `X`) leaves just that tab behind, right where it was, with a count of what's inside. Click the `+N` to unfold.
  - **Double-click inside a frame to OPEN it** — the canvas becomes its inside, and a trail at the
    top-left brings you back out. See "Open a frame".
- **Frame (horizontal)** — a frame whose children auto-flow left→right, wrapping to the next row; reflows as you resize. Drag a card to reorder — a line shows where it will land.
- **Frame (vertical)** — a frame whose children auto-flow top→bottom, wrapping to the next column.

**Tabs are not a layout you pick** — several frames can share **one box** as tabs, and you make that
by dragging:

- **Drag a frame onto another frame's tab** to dock it there. The two names become two tabs on the same box, and the frame you dropped is the one showing.
- **A plain card works too** — dropped on a tab it becomes a frame and joins the row, bringing its children along. (A frame shows no note text, so a card's note waits out of sight until you turn it back into a card.) Images, annotations and stacks can't be tabs; drop one on a tab and it simply goes into the box.
- **Click a tab** to show that frame's contents — the others are put away, not deleted. Double-click it to rename it, like any frame tab.
- **Drag a tab sideways** along the row to reorder it; a line shows the gap it will drop into.
- **Drag a tab off the box** to give it its own frame back, at the size and with the contents it had. Take the last one out and the empty box goes with it — that's how you undo tabs.
- Whatever you drop, add or paste into the box belongs to the **tab that's open**, so each tab keeps its own contents.
- The box takes the **colour of the open tab**, so switching tabs re-tints it.
- **Clicking the box selects the open tab** — there's no separate "group" to look after, so colouring, renaming and deleting all act on the tab you can see. The box still moves and resizes with it.
