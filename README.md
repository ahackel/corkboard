# Corkboard

A single-file visual editor for a **local folder of Markdown notes**.
Every `.md` file becomes a card on an infinite canvas; edits are saved straight back to
disk as plain Markdown.

**[▶ Open the app](https://andreashackel.de/corkboard/)** · **[What it is, with pictures](https://andreashackel.de/corkboard/about/)** — what it is for, and what it is not,
is in [docs/PRODUCT.md](docs/PRODUCT.md).

## How it works

The deployed app is a single static `index.html` — no server, no backend, no runtime
dependencies. (Source lives in `src/` and is bundled back into that one file at build
time; see *Hosting* below.) It's **local-first**: the map is saved in a private on-device
store (the browser's
[Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system))
and reopens automatically every visit — no sign-in, no setup, works on every browser
including iPad. Notes never leave the machine, and once it has loaded the app opens without a
network (a small service worker keeps the last copy of the page).

A map is a **folder**: one `.md` file per card, and a **section is a sub-folder** (its label is
its `_index.md`), so Finder and Obsidian see the same grouping the board shows. A note's path is
its identity, and its title is the body's leading `# ` heading, which the filename follows — a file
you named yourself keeps its name until you change that heading.
Frontmatter describes the note (`tags`, `color`, a few `mm_*` keys); serialization rewrites only
those app-owned keys and preserves every other field and the note body verbatim. The board's
**arrangement** — positions, sizes, folded sections and the lines you draw — lives in one
`board.json` beside the notes, keyed by path. There is no database. The full format is in
[public/format.md](public/format.md), published next to the app.

## Storage

All file I/O goes through a single swappable `store` adapter (`src/store/`). The two
main implementations share one interface:

- **`opfsStore`** — the local-first on-device default (Origin Private File System). Works on
  every browser incl. iPad; per-device, no built-in cross-device sync.
- **`fsaStore`** — a real local folder on Chrome/Edge (File System Access API), autosaved
  directly. Point it at a cloud-synced folder (iCloud Drive, Dropbox, …) and the map lives
  in that cloud with no app-side server config.

Two more cover the edges: `idbStore`, the on-device fallback where OPFS cannot write, and
`noteStore`, which opens ONE `.md` file as a map of a single card.

`.zip` **import / export** moves a map in and out (the inline ZIP reader/writer is
zero-dependency). Add `?nofsa` to the URL to preview the no-local-folder (iPad-style)
layout on desktop.

## Features

- Cards rendered from a hand-rolled Markdown subset — headings, links, emphasis, task lists, tables
- Free placement; sections to group cards, which nest and can be folded or opened to work inside
- Stacks: hold a card over another to pile them up, click to fan the pile out
- A pasted list becomes one card per item; number keys 1–9 colour the selection
- Colours and Obsidian tags; lines between cards with arrows, dots and labels
- Smart guides while dragging, tidy-up on request, search
- Undo / redo, image paste & drop, PNG/PDF export, and ⌘P to find every action
- Autosave back to the source files, with a visible warning if a save fails

## Architecture

`src/` is split into domain folders, all fully strict-typed TypeScript: `core/` (shared
mutable `state` + interaction `ui`), `utils/` (pure helpers — Markdown, frontmatter, model
queries), `store/` (the swappable I/O boundary), `data/` (load, autosave, `board.json`, zip
import/export), `view/` (camera, layout, geometry, colour, lines), `nav/` (open sections and
the URL), `features/` (the interactive subsystems — drag, gestures, inline-edit, crud, stacks,
attachments, search, history, the ⌘P palette), and `main.ts` (the render core). Replacing only
the `store` object would retarget the app to an Obsidian vault or a Tauri/native build.

## Hosting

A GitHub Action (`.github/workflows/deploy.yml`) bundles the source with Vite
(`vite-plugin-singlefile`) into a self-contained `dist/index.html` and deploys it to GitHub
Pages on every push to `main`. Pages "Source" is set to *GitHub Actions* in the repo
settings.

To run locally: `npm install`, then `npm run dev` (Vite dev server on `localhost:5173`).
The on-device store needs a secure context, so use the dev server rather than opening the
file directly. `npm run build` produces the deployable single-file `dist/`; `npm run
typecheck` runs `tsc --noEmit`.

Tests: `npm test` checks the file format (vitest). `npm run e2e` drives the app in a real
browser (Playwright, `e2e/`); the first time, install its browser with
`npx playwright install chromium`. Every pull request runs typecheck, lint and both suites
(`.github/workflows/ci.yml`), and so does the deploy before it publishes. Node 22 (`.nvmrc`).

## Versioning

The displayed version is set by the deploy workflow: `0.1.<GitHub run number>`, so it
bumps automatically per deploy — local builds show `0.1.0-dev` instead. It's shown at
the bottom of the home sidebar (home button, top left).

## License

Open source under the [MIT License](LICENSE).
