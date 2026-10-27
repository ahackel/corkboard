# Corkboard — what it is, and what it is not

This is the north star. Every change is checked against it; a feature that doesn't serve it goes,
however well it is built. (Engineering rules live in [architecture.md](architecture.md).)

## The picture

> **A bright, playful wall of sticky notes for sorting your thoughts by hand.**
> It opens instantly onto a clean canvas with almost no buttons. Typing makes a card, a pasted list
> becomes many cards, and dragging feels physical. Zoomed out, the board reads like a map of your
> thinking. Underneath, it is a folder of plain Markdown files.

The core loop is **pour in → cluster by hand → distill**. The most valuable moment is the middle
one: moving cards until the structure becomes visible. The arrangement IS the understanding.

What it has been used for, and what it must stay good at:
- sorting a large pile of collected ideas (the Micro Gravity game-idea collection);
- a daily work log, distilled into weekly summaries;
- brainstorming.

## Principles — the test for every change

1. **The canvas is the interface.** No permanent toolbars. Actions come from the keyboard,
   double-click, the bar that appears on a selection, and the ⌘K command palette.
2. **You arrange; the app assists.** Nothing moves, resizes or reroutes on its own. Guides and
   tidy-up help only while you drag or when you ask.
3. **Every interaction should feel good.** Smooth motion, soft snapping, cheerful colours. A feature
   that feels clunky doesn't ship.
4. **Capture costs nothing.** From thought to card is one keystroke.
5. **One way to do each thing.** If two features overlap, keep one.

## Look and feel

- **FigJam's look**, one theme (no dark mode): a pale grey board, pastel sticky notes on a soft
  shadow, white chrome, a dark toolbar over whatever is selected, FigJam's selection handles, ports and
  two-row colour picker, a dock at the bottom centre. Minimal chrome and instant, in the spirit of
  Excalidraw / tldraw.
- A default card is a **coloured sticky note**. Type is a **friendly rounded sans** (the system's
  rounded face, with a bundled fallback so it works offline from the single file).

## Where it lives

- **Desk first.** Sorting happens with a mouse and keyboard.
- **Its own home.** Corkboard keeps its own notes; the Markdown format keeps them safe and readable
  by Obsidian, which doubles as the reading/wiki view. Corkboard does not grow a document view.
- **The phone is an inbox, not a second app.** Notes dropped into the synced folder from a phone
  show up in an Inbox pile to sort at the desk. No mobile canvas work is a priority.

## Features

**Core — keep, and make each feel great:** cards with Markdown, free placement, frames to group
cards, colour and tags, simple lines between cards, tidy-up of a selection (only on request), search, undo, pasted images, a pasted list
becoming one card per item, smart alignment and spacing guides while dragging, collapse, opening a
card or frame to work inside it, and the ⌘K command palette — every action, with its shortcut, in
one searchable list.

**Two things, one rule.** There are cards and frames, nothing else:
- A **card** is a note. It never holds other cards — structure inside a thought is written into the
  note (lists, `- [ ]` tasks).
- A **frame** is a FigJam-style section: a pale box with its name (and an optional one-line
  description) on a label above it. Delete the text and it's an untitled box; the toolbar's T brings
  the name back. Cards sit in it wherever you put them, and frames nest. On disk a frame IS a
  folder of its cards, so Finder and Obsidian see the same grouping; a folded frame isn't even read
  until you open it, which keeps a big board quick.
- **The rule:** a card is in the frame its centre is over — whether you drop the card there, or move,
  resize or draw the frame over it. A frame grows to hold what you drop into it, so nothing is hidden
  past its edge.

**Tags are for finding.** A tag is an Obsidian tag — a word, or an emoji as its shortest form — worn on
the card's top edge as a stamp or a label. `#` tags the selection, or drag a sticker from the tag tray onto
a card; drag a tag to another card to move it, off onto the board to remove it. One search (⌘F) finds by
text and tags together, and a click on any tag puts it in the search.

**To build, in order:** frame titles that grow readable when
zoomed out · export a selection or board as PNG · phone inbox.

**Cut — and why:**
- *Sketch / pen layer* — drawing is not sorting.
- *Tab groups and query cards* — rarely used, and each multiplied the layout rules.
- *Annotations* — a sticky on a sticky; a coloured card does the job.
- *Routed lines with ports and junction points* — a line only has to say "these belong together".
  Lines that reroute themselves broke principle 2.
- *The permanent toolbar* — replaced by ⌘K and the selection bar.
- *The help map* — the palette lists every action with its shortcut; that is the reference.
- *Outline view (and its phone editor)* — built for working on a phone; the phone is an inbox now,
  search finds things, and Obsidian is the reading view.
- *Cards inside cards (the outliner), checklist mode, and frames that auto-arrange their cards* — two
  kinds of container with different rules, and a drop could nest a card by accident. Old maps open
  with those cards turned into frames.

## Known friction to fix (from daily use)

- **Layout fights me**: card sizes and overlaps need constant fixing. (Fixed so far: lines route as
  tidy elbows from card to card; dropping never nests a card by accident; guides line cards up while dragging.)
- **Boards get messy** over weeks. First try a routine with existing features (a "This week" frame;
  on Friday, write a summary card, fold the week's frame to its pill — the arrow on its
  label, or X — and move on to next week's frame) before building anything for it. A dedicated daily-log
  design (a checklist card per day, a done counter, a Today command) is sketched and parked.
