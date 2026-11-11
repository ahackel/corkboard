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
   double-click, the bar that appears on a selection, and the ⌘P command palette.
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
  by Obsidian, which doubles as the reading/wiki view. Corkboard does not grow a document view. A file
  somebody else named keeps its name, and once loaded the app opens without a network.
- **The phone is an inbox, not a second app.** Notes saved into the map's `Inbox/` folder from a phone
  show up in the Inbox section to sort at the desk ([inbox.md](inbox.md): a map folder in iCloud Drive plus
  an iOS Shortcut). It needs a FOLDER map; one in the browser's own storage can't be reached from a phone.
  No mobile canvas work is a priority.
- **One note on its own.** A single `.md` file (a note in an Obsidian vault, a file from Finder) opens as a
  map of that ONE card, to edit it as a sticky. It is not a second kind of board: nothing adds a card beside
  it, and sorting many notes still means a folder. Dragged in from Finder, a note OPENS when dropped on the
  pill that appears at the top, and is ADDED as a card when dropped anywhere on the board.

## Features

**Core — keep, and make each feel great:** cards with Markdown, free placement, sections to group
cards, colour and tags, lines between cards (port to port; an end can sit anywhere along a side, FigJam-style), tidy-up of a selection (only on request), search, undo, pasted images, a pasted list
becoming one card per item (text or links dropped from another app work the same), copy that other apps read as
clean text (a note, or an outline) — or as formatted text, for a doc or a mail, number keys 1–9 to colour the selection, smart alignment and spacing guides while dragging, collapse, opening a
section to work inside it, and the ⌘P command palette — every action, with its shortcut, in
one searchable list.

**Two things, one rule.** There are cards and sections, nothing else:
- A **card** is a note. It never holds other cards — structure inside a thought is written into the
  note (lists, `- [ ]` tasks).
- A **section** is a FigJam-style section: a pale box with its name (and an optional one-line
  description) on a label above it. Delete the text and it's an untitled box; the toolbar's T brings
  the name back. Cards sit in it wherever you put them, and sections nest. On disk a section IS a
  folder of its cards, so Finder and Obsidian see the same grouping; a folded section isn't even read
  until you open it, which keeps a big board quick.
- A **stack** is a section drawn as a pile, like a Dock stack: hold a dragged card over another for a moment
  and they stack; drop more on the pile to add them on top. A click fans it out to read; drag the pile to lift
  the card under the pointer off (the top one, or a lower one showing), or its red pin to move it whole. Unstack spreads the cards out again, or Turn into section
  gives them a box. Down to one card, it lets go of it.
- **The rule:** a card is in the section its centre is over — whether you drop the card there (a dragged
  group all goes into the section under the pointer), or move,
  resize or draw the section over it. Only you resize a section (its handles, or Resize to fit); what
  sticks out past its edge is clipped until you do. Drop cards on a FOLDED section's pill to file them in it, or on a crumb of the path to move
  them up out of the section you're in.

**Tags are for finding.** A tag is an Obsidian tag — a word, or an emoji as its shortest form — worn on
the card's top edge as a stamp or a label. `#` tags the selection, or drag a sticker from the tag tray onto
a card; drag a tag to another card to move it, off onto the board to remove it. One search (⌘F) finds by
text and tags together, and a click on any tag puts it in the search.

**To build, in order:** nothing queued. (Done: section names keep their screen size when
zoomed out · the phone inbox · export the board or a selection as PNG or PDF from ⌘P.)

**Cut — and why:**
- *Sketch / pen layer* — drawing is not sorting.
- *Tab groups and query cards* — rarely used, and each multiplied the layout rules.
- *Annotations* — a sticky on a sticky; a coloured card does the job.
- *Junction points, and lines that route around other cards* — a line only has to say "these belong
  together". Lines that reroute themselves broke principle 2: a line goes port to port, and avoids only
  the two cards it joins.
- *A section's description* — its label is its name alone; anything else in its note stays in the file, unshown.
- *SVG export* — it could only wrap HTML, which each viewer draws differently (or not at all); PNG does the job.
- *The permanent toolbar* — replaced by ⌘P and the selection bar.
- *The help map* — the palette lists every action with its shortcut; that is the reference. (An EMPTY
  map shows one line saying how to begin, gone with the first card: a hint, not a manual.)
- *Read-only mode* — set aside for now: one more mode to explain, and its `R` key was easy to hit by accident.
- *Outline view (and its phone editor)* — built for working on a phone; the phone is an inbox now,
  search finds things, and Obsidian is the reading view.
- *Cards inside cards (the outliner), checklist mode, and sections that auto-arrange their cards* — two
  kinds of container with different rules, and a drop could nest a card by accident. Old maps open
  with those cards turned into sections.

## Known friction to fix (from daily use)

- **Layout fights me**: card sizes and overlaps need constant fixing. (Fixed so far: lines route as
  tidy elbows from card to card; dropping never nests a card by accident; guides line cards up while dragging.)
- **Boards get messy** over weeks. First try a routine with existing features (a "This week" section;
  on Friday, write a summary card, fold the week's section to its pill — the arrow on its
  label, or X — and move on to next week's section) before building anything for it. A dedicated daily-log
  design (a checklist card per day, a done counter, a Today command) is sketched and parked.
