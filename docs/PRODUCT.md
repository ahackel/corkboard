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

- Bright and playful, in the spirit of Excalidraw / tldraw (minimal chrome, instant) and Apple
  Freeform / FigJam (friendly, approachable).
- A default card is a **coloured sticky note**. Type is a **friendly rounded sans** (the system's
  rounded face, with a bundled fallback so it works offline from the single file).

## Where it lives

- **Desk first.** Sorting happens with a mouse and keyboard.
- **Its own home.** Corkboard keeps its own notes; the Markdown format keeps them safe and readable
  by Obsidian, which doubles as the reading/wiki view. Corkboard does not grow a document view.
- **The phone is an inbox, not a second app.** Notes dropped into the synced folder from a phone
  show up in an Inbox pile to sort at the desk. No mobile canvas work is a priority.

## Features

**Core — keep, and make each feel great:** cards with Markdown, free placement, nesting (a card
with children is an outline; frames group), colour and tags, simple lines between cards, search,
undo, pasted images, collapse, opening a card or frame to work inside it, and the ⌘K command
palette — every action, with its shortcut, in one searchable list.

**To build, in order:** paste a list → many cards · smart alignment guides
while dragging · tidy-up of a selection (only on request) · frame titles that grow readable when
zoomed out · emoji tags presented as stamps · export a selection or board as PNG · phone inbox.

**Cut — and why:**
- *Sketch / pen layer* — drawing is not sorting.
- *Tab groups and query cards* — rarely used, and each multiplied the layout rules.
- *Annotations* — a sticky on a sticky; a coloured card does the job.
- *Routed lines with ports and junction points* — a line only has to say "these belong together".
  Lines that reroute themselves broke principle 2.
- *The permanent toolbar* — replaced by ⌘K and the selection bar.
- *The help map* — the palette lists every action with its shortcut; that is the reference.

## Known friction to fix (from daily use)

- **Layout fights me**: card sizes and overlaps need constant fixing. (Lines rerouting when cards
  move is fixed: lines now run straight from card to card.)
- **Boards get messy** over weeks. First try a routine with existing features (a "This week" frame;
  on Friday, write a summary card, move the week's cards into it, collapse it) before building
  anything for it.
