# Corkboard map format

How to write a map that [Corkboard](https://andreashackel.de/corkboard/) opens, by hand or from a script.
This file is served next to the app and kept current with it; the app's own tests pin the format.

## A map is a folder

```
My Map/
  board.json              ← arrangement: positions, sizes, lines, view settings
  Intro.md                ← a card at the top level
  Ideas/                  ← a SECTION is a folder…
    _index.md             ← …whose note is its _index.md (its label)
    First idea.md         ← a card inside the section
    Deeper/               ← sections nest
      _index.md
```

- **One `.md` file per card. Its PATH is its identity**: `board.json` refers to notes by path,
  relative to the map folder, with `/` separators (`Ideas/First idea.md`, `Ideas/_index.md`).
- **Which section holds a card is where its file sits.** There is no parent field.
- **Cards never hold cards.** Only a section (a folder) contains anything.
- Other folders (e.g. `attachments/` for images) are not sections.

To open a map: "Open folder" in Chrome/Edge, or zip it and use Import in any browser.
One note on its own opens too ("Open a note…", or drag it onto the window's "edit in place" pill;
Chrome/Edge): it is a map of that single card, edited in place under its own filename; its layout is
kept in the browser, not beside it.

## A note

```markdown
---
date: 2026-11-08
tags: [idea, draft]
color: blue
---

# The title

The body: a small Markdown subset.
```

- **The title is the body's leading `# ` line and nothing else.** No heading = an untitled sticky.
  It is not read from frontmatter or the filename.
- **The filename is a slug of the title**: the title with `/ \ : * ? " < > |` replaced by `-`,
  whitespace collapsed, at most 120 chars, plus `.md`. On a clash, append ` 2`, ` 3` (`Notes 2.md`).
  The app re-derives it on save, so a mismatch is harmless, but writing it right keeps `board.json` stable.
- **Frontmatter is optional.** App-owned keys: `tags` (Obsidian tags, written bare), `color`, and `mm_*`.
  Every other key is kept verbatim.
  - `color`: a palette key or a custom hex, QUOTED (`color: "#ff8800"`; bare `#` is a YAML comment).
    Sticky (pastel) keys: `grey red orange amber green teal blue violet pink silver`.
    Strong keys: `black stone bold-red bold-orange bold-yellow bold-green bold-teal bold-blue bold-violet bold-pink white`.
    Text colour is derived from the fill; never set it.
  - `mm_type: frame` marks a section's `_index.md` (sections: the folder already says so; write it anyway).
  - `mm_locked: true` locks a card.
- **A section's `_index.md`** holds its name (`# Name`), shown on its label ABOVE the box. The label shows
  the name only: anything else in the note is kept but never displayed.
- **Body Markdown**: headings, paragraphs, `-`/`1.` lists, `- [ ]` task lists, `**bold**`, `*italic*`,
  `` `code` ``, `[links](url)`, `#tags`, pipe tables, images `![](attachments/x.png)`.
  A note whose whole body is one image becomes an image card.

## board.json

```json
{
  "version": 1,
  "model": 2,
  "settings": { "grid": "dot", "gridSize": 20 },
  "nodes": {
    "Intro.md":            { "x": 0,   "y": -300, "w": 400 },
    "Ideas/_index.md":     { "x": 0,   "y": 0,    "w": 500, "h": 400 },
    "Ideas/First idea.md": { "x": 20,  "y": 20,   "w": 220, "h": 120 }
  },
  "edges": [
    { "id": "e1", "from": "Intro.md", "to": "Ideas/_index.md", "dashed": false,
      "toCap": "arrow", "fromPort": "down", "toPort": "up", "toAt": 0.25, "label": "leads to" }
  ]
}
```

- **`nodes`**, keyed by path. Every key optional:
  - `x`, `y`: position of the top-left corner, RELATIVE TO THE CONTAINING SECTION's top-left
    (world origin for top-level notes). Integers.
  - `w`, `h`: size. A card's `w` defaults to 200. A card's `h` is a MINIMUM: its text can make it
    taller. A section's `w`/`h` is its box, exactly; it never grows to fit its cards, so size it yourself.
  - `collapsed: true` folds a card to a chip and a section to its pill. **A section with no entry
    here opens FOLDED**, so give every `_index.md` an entry.
- **`edges`** are drawn lines; they mean nothing structural.
  - `from`/`to`: note paths (a section's `_index.md` joins to the section box). `id`: any unique string.
  - `dashed`: always write it (`false` = solid).
  - `fromCap`/`toCap`: `none` | `dot` | `arrow`. Defaults: `fromCap` none, `toCap` arrow.
  - `fromPort`/`toPort`: `up` | `down` | `left` | `right` pins the line to that face; omitted, the
    face is chosen from where the two boxes are.
  - `fromAt`/`toAt`: where along its pinned face that end sits, 0–1 from the face's top/left. Omitted =
    0.5, the middle. Ignored without a port.
  - `color`: a palette key or hex. `label`: short text drawn on the line.
- **Routing**: lines are orthogonal elbows that always run port to port: from the middle of a face (or the
  `fromAt`/`toAt` point of a pinned one) to the middle of a face. They avoid ONLY the two boxes they join and
  never route around other cards, so lay cards out so lines don't have to cross anything.
- `settings.grid`: `none` | `dot` | `mesh` | `line`. `settings.canvasColor`: optional colour.

## Layout notes

- A section's LABEL is drawn above its box at constant screen size: zoomed out to ~35%, it covers about
  150 world px above the box. Leave that much space above every section.
- A card's natural height is about 31px + 20px per line of text (its `# ` title counts as a line), +8px
  per paragraph gap. Text is 14px and wraps at about 28 characters per line at `w: 220`.
- A section's label is clipped to the section's width: keep names short.
