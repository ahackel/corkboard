// ============================================================
// Markdown frontmatter parse/serialize.
// Frontmatter is parsed as ORDERED entries so unknown keys round-trip untouched: each
// entry groups a top-level `key:` line with any following continuation lines (indented
// values, `- list` items, blanks, comments) until the next top-level key. This lets us
// rewrite ONLY the app-owned keys (tags/color/mm_*) while preserving everything else —
// `date`, `category`, `aliases`, custom fields, and the note body — verbatim.
// ============================================================
import { type MindNode, type NodeType, type FmEntry } from '../core/state.js';

// ---------- a note's TITLE is the leading heading of its body ----------
// `# Notes` on the first non-blank line IS the title, and nothing else is. Not a frontmatter key,
// and NOT the filename: the filename is a derived slug that may carry a ` 2` suffix to stay unique
// on disk, so reading the title back off it would put that suffix into the title. Storing it as the
// body's first line instead means duplicate titles need no new frontmatter key at all — and it's
// what a Markdown author writes anyway, so the file reads correctly in Obsidian and every other
// renderer.
// NO heading means the card is UNTITLED — a sticky note that is only its text. That's why this tests
// for `#` alone: firstLineLabel (below) also strips bullets, quotes and list numbers, which is right
// when minting a label out of arbitrary dragged text and wrong here — a note starting `- milk` is a
// list, not a card titled "milk".
//
// Where does this text actually START — the index of its first non-blank line, or -1 if it has none.
// The ONE spelling of that question: splitHeading, firstLineLabel, the editor's heading probes
// (features/inline-edit.ts) and collapsedMarkdown (main.ts) all read it, and the four hand-written
// copies it replaced had already drifted apart over the all-blank case.
export function firstTextLine(lines: string[]): number {
  return lines.findIndex(l => l.trim());
}
// Is THIS line a heading, and if so where does its text begin — the FORMAT rule, in one regex. The
// title is optional so a bare `# ` still matches: the editor needs to know a marker is sitting there
// (to strip it again if nothing gets typed after it) where splitHeading reads that as untitled.
// `markerLen` is what a caret must clear to land on the title, so nothing has to hard-code `'# '`.
export function headingOnLine(line: string): { markerLen: number; title: string } | null {
  const m = line.match(/^([^\S\n]*#{1,6}[^\S\n]+)(.*\S)?[^\S\n]*$/);
  return m ? { markerLen: m[1].length, title: (m[2] ?? '').trim() } : null;
}
// `gap` is whether a BLANK LINE separated the heading from the note — the one thing about the split
// that the two fields can't hold, and so the one thing a round-trip would otherwise invent. Write
// `# Title` with the text on the very next line and it must stay there: joinHeading below reads this
// back, and MindNode.titleGap carries it between the two. Untitled and body-less notes report the
// default (true), so putting a title or a body on one later spaces it the ordinary way.
export function splitHeading(text: string): { title: string; body: string; gap: boolean } {
  const lines = text.split('\n');
  const i = firstTextLine(lines);
  if (i < 0) {
    return { title: '', body: '', gap: true };
  }
  const h = headingOnLine(lines[i]);
  if (!h || !h.title) {
    return { title: '', body: text.trim(), gap: true };
  }
  const rest = lines.slice(i + 1);
  const body = rest.join('\n').trim();
  return { title: h.title, body, gap: body ? !rest[0]?.trim() : true };
}
// …and back. The inverse of splitHeading, so a load/save round-trip is a no-op: an untitled note is
// its body alone, and a titled one gets its heading back as the first line — over a blank line unless
// the note is one of the tight ones (`gap: false`). The default is `true` for the callers that build a
// note rather than re-reading one (a merge, an extract, the clipboard), where spaced is what to write.
export function joinHeading(title: string, body: string, gap = true): string {
  const t = title.trim(), b = body.trim();
  if (!t) {
    return b;
  }
  return b ? `# ${t}\n${gap ? '\n' : ''}${b}` : `# ${t}`;
}
// A node's title and body from the whole text of its note (the editor's text, a cut, a split).
export function setNoteText(n: MindNode, text: string): void {
  const { title, body, gap } = splitHeading(text);
  n.title = title;
  n.body = body;
  n.titleGap = gap;
}

// A note's path -> its bare name, no directory and no `.md`. The title used to be read from exactly
// this, and it survives in two places for that reason: the one-shot migration of a body-less note
// (data/load.ts loadFromDir) and the last resort for SHOWING a name (utils/model.ts nodeLabel).
export function fileStem(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}
// A human LABEL off the first non-blank line of arbitrary text, shorn of whatever markdown marker
// introduced it — a heading's #, a bullet, a quote, a list number. Deliberately WIDER than
// splitHeading, and the two must not be confused: this mints a name for something that hasn't got
// one (an untitled card's filename slug, the text-drag ghost's caption), where any first line will
// do; splitHeading answers the FORMAT question "does this note carry a title", which only `#` may
// answer — or a note beginning `- milk` would be a card titled "milk" instead of a list.
const MARKER_RE = /^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/;
// The LABEL ALONE, which is what nearly every caller wants — nodeLabel (on every display site, in
// search's filter and its sort comparator) and the filename slug. Kept apart from the pair below
// because that one rebuilds the whole remaining body just to hand it back, and a note's body can be
// long: paying O(body) in two allocations per row of a list is real work for a string nobody reads.
export function firstLineLabel(text: string): string {
  const m = text.match(/^[^\S\n]*\S.*$/m);
  return m ? m[0].replace(MARKER_RE, '').trim() : '';
}
// …and the same first line WITH the rest of the text as a body — the split form, for the one caller
// that is really breaking text in two (the text-drag ghost's caption + its new card's note).
export function firstLineSplit(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  let i = firstTextLine(lines);
  if (i < 0) {
    i = 0;
  }
  return { title: (lines[i] ?? '').replace(MARKER_RE, '').trim(),
           body: lines.slice(i + 1).join('\n').trim() };
}

// The shape parseMd yields — a node-to-be plus its raw layout (mm_*) values.
export interface ParsedNote {
  title: string;
  fmEntries: FmEntry[];
  color: string;
  keepStatus: string;
  tags: string[];
  body: string;
  titleGap: boolean;
  mm: {
    parent: string;
    px: number | null;   // mm_position_x/y — position relative to parent (current fields)
    py: number | null;
    x: number | null;    // mm_x/mm_y — legacy absolute position (read as fallback)
    y: number | null;
    w: number | null;
    h: number | null;
    collapsed: boolean;
    locked: boolean;
    blank: boolean;      // mm_blank — this note is empty ON PURPOSE (see serializeMd)
    type: NodeType;
    // This note used to be a STACK (`mm_type: stack`, or the older `mm_layout: stack`). It folds to
    // a plain card — but the flatten migration needs to tell a stack and a plain card apart: a stack's children were already INSIDE it and must stay nested, while a plain card's
    // children sat BESIDE it and become top-level cards joined by edges (data/persistence.ts
    // flattenLegacyBranches). Meaningless once a map has been migrated.
    wasStack: boolean;
  };
}

function parseFM(fmText: string): FmEntry[] {
  const entries: FmEntry[] = [];
  for (const line of fmText.split('\n')){
    const m = line.match(/^([\w-]+):(.*)$/);
    if (m) {
      entries.push({ key: m[1], lines: [line] });
    } else if (entries.length) {
      entries[entries.length-1].lines.push(line);   // continuation
    } else {
      entries.push({ key: null, lines: [line] });
    }
  }
  return entries;
}
function fmEntry(entries: FmEntry[], key: string): FmEntry | undefined { return entries.find(e => e.key === key); }
function fmValue(entries: FmEntry[], key: string): string {
  const e = fmEntry(entries, key);
  if (!e) {
    return '';
  }
  return e.lines[0].slice(e.lines[0].indexOf(':')+1).trim();
}
// A tag is written bare (`tags: [idea, 🔥]`), but Obsidian also takes a quoted `"#idea"` — the `#` is
// not part of the tag (utils/tags.ts).
function fmTags(entries: FmEntry[]): string[] {
  const e = fmEntry(entries, 'tags');
  if (!e) {
    return [];
  }
  const inline = e.lines[0].slice(e.lines[0].indexOf(':')+1).trim();
  const bare = (s: string): string => s.trim().replace(/^["']|["']$/g,'').replace(/^#/,'').trim();
  if (inline) {
    return inline.replace(/^\[|\]$/g,'').split(',').map(bare).filter(Boolean);
  }
  return e.lines.slice(1).map(l=>l.trim()).filter(l=>l.startsWith('-'))   // YAML list form
    .map(l=>bare(l.replace(/^-\s*/,''))).filter(Boolean);
}
function fmSet(entries: FmEntry[], key: string, line: string): void {
  const e = fmEntry(entries, key);
  if (e) {
    e.lines = [line];
  } else {
    entries.push({ key, lines:[line] });
  }
}
function fmRemove(entries: FmEntry[], key: string): void {
  const i = entries.findIndex(e => e.key === key);
  if (i >= 0) {
    entries.splice(i, 1);
  }
}

// Resolve a note's kind from frontmatter, folding legacy tokens. There are TWO kinds, card and section,
// and nothing else to choose: a card is a note, a section is a box that holds cards (docs/PRODUCT.md).
// `mm_type` (card|frame, default card) is the current field; on disk a section is still `frame`, the
// file format's word from before the rename, so old and new maps read the same. Everything older folds onto those two:
//  · `image`, `stack`, `query`, `annotation` → card. Each was a kind once and was cut or derived away;
//    an old note simply opens as a card. A stack's children are turned into a section's on load
//    (data/migrate.ts foldCardsIntoSections), like any card's.
//  · LEGACY notes with no mm_type: a single `mm_layout` token conflated kind and arrangement —
//    `frame`/`frame-h`/`frame-v` → section, anything else → card.
// `mm_layout` is no longer READ for anything else: a section's children sit where you put them (the
// flows, tabs, line and fan arrangements are all cut), and the stale key is dropped on the next write.
function foldType(entries: FmEntry[]): { type: NodeType; wasStack: boolean } {
  const t = fmValue(entries, 'mm_type'), v = fmValue(entries, 'mm_layout');
  if (t === 'frame' || (!t && (v === 'frame' || v === 'frame-h' || v === 'frame-v'))) {
    return { type: 'section', wasStack: false };
  }
  return { type: 'card', wasStack: t === 'stack' || (!t && v === 'stack') };
}

export function parseMd(text: string): ParsedNote {
  // A note written on Windows (CRLF) or with a BOM must still have its frontmatter FOUND: missed, the
  // whole block would read as body text and the next save would stack a second block above it. The
  // note is written back with plain \n — the only change a save makes to text the app doesn't own.
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const entries = m ? parseFM(m[1]) : [];
  // The TITLE is the body's leading heading (splitHeading above); no heading = an untitled card.
  // The filename is deliberately NOT consulted — it's a derived slug, suffix and all.
  const { title, body, gap } = splitHeading(m ? m[2] : text);
  const num = (v: string): number | null => (v !== '' && !isNaN(+v)) ? +v : null;
  return {
    title,
    fmEntries: entries,                    // full original frontmatter, preserved on save
    // a palette key (`blue`) or a custom hex — which is written QUOTED, since a bare #rrggbb is a
    // comment to every other YAML reader (Obsidian included), so strip the quotes back off here
    color: fmValue(entries, 'color').replace(/^["']|["']$/g, ''),
    keepStatus: fmValue(entries, 'status'),
    tags: fmTags(entries),
    body,                                  // already trimmed, and shorn of the title heading
    titleGap: gap,                         // was there a blank line under the heading (see splitHeading)
    // layout keys — note identity is its filename; parent stored as the PARENT note's path.
    mm: {
      parent: fmValue(entries, 'mm_parent'),
      // Position RELATIVE to the parent (world origin for roots). `px`/`py` are the current
      // fields; `x`/`y` are the legacy absolute fields, read as a fallback (see data/persistence.ts).
      px: num(fmValue(entries, 'mm_position_x')),
      py: num(fmValue(entries, 'mm_position_y')),
      x: num(fmValue(entries, 'mm_x')),
      y: num(fmValue(entries, 'mm_y')),
      w: num(fmValue(entries, 'mm_w')),
      h: num(fmValue(entries, 'mm_h')),
      collapsed: fmValue(entries, 'mm_collapsed') === 'true',
      locked: fmValue(entries, 'mm_locked') === 'true',
      blank: fmValue(entries, 'mm_blank') === 'true',
      ...foldType(entries),
    },
  };
}
function todayISO(): string { return new Date().toISOString().slice(0,10); }
// Rebuild the file from the ORIGINAL frontmatter entries, touching only the app-owned keys:
// tags, color, and the mm_* layout. `date`, `category`, `aliases`, custom fields, etc. are
// kept verbatim; `date` is stamped only when the note has none yet (never overwritten).
export function serializeMd(n: MindNode): string {
  const entries: FmEntry[] = (n.fmEntries || []).map(e => ({ key: e.key, lines: [...e.lines] }));
  // strip any stale mm_* (re-added fresh below); the prefix match covers every layout key
  entries.filter(e => e.key && e.key.startsWith('mm_')).forEach(e => fmRemove(entries, e.key as string));
  fmSet(entries, 'tags', `tags: ${n.tags.length ? `[${n.tags.join(', ')}]` : '[]'}`);
  // A custom colour is a hex, and `color: #ff8800` reads as an EMPTY value plus a comment to any
  // real YAML parser — so quote it. Palette keys stay bare, the way every existing vault has them.
  if (n.color) {
    fmSet(entries, 'color', `color: ${n.color.startsWith('#') ? `"${n.color}"` : n.color}`);
  } else {
    fmRemove(entries, 'color');
  }
  if (!fmEntry(entries, 'date')) {
    entries.unshift({ key:'date', lines:[`date: ${todayISO()}`] });
  }
  // GEOMETRY IS NOT WRITTEN HERE any more — position, size and collapse live in board.json
  // (data/board.ts), which is what "frontmatter describes the NOTE, board.json describes the BOARD's
  // arrangement of it" means in practice. mm_position_x/y, mm_w/mm_h and mm_collapsed are still READ
  // (parseMd) so an older vault opens unchanged, and the stale-mm_* sweep at the top drops them from
  // each note the first time it is rewritten. Neither is the PARENT written any more: a section is a
  // folder, so where the file sits says which section holds it (utils/filenames.ts parentFileOf), and
  // the old `mm_parent` is swept with the rest.
  if (n.locked) {
    entries.push({ key:'mm_locked', lines:['mm_locked: true'] });
  }
  // A note that is blank ON PURPOSE — the user cleared every character out of an existing card, which is
  // allowed and keeps the card's file, children and position (features/inline-edit.ts endBodyEdit). On
  // disk that is indistinguishable from a note written before titles moved into the body, whose name WAS
  // its filename and whose body was empty — and loadFromDir migrates that one by promoting the stem to a
  // heading, which would put the name the user just deleted straight back. Nothing else on disk can tell
  // the two apart (mm_position_x predates the title move by a hundred commits, so its presence says
  // nothing), so the blankness is STATED rather than inferred. Written only while there is nothing else to
  // write, and dropped again by the stale-mm_* sweep at the top as soon as anything is typed.
  if (!n.title.trim() && !n.body.trim()) {
    entries.push({ key:'mm_blank', lines:['mm_blank: true'] });
  }
  if (n.type !== 'card') {
    entries.push({ key:'mm_type', lines:['mm_type: frame'] });   // card is the default; the only other kind is a section
  }
  const fm = entries.flatMap(e => e.lines).join('\n');
  // The title goes back where it lives: the body's leading heading (joinHeading — the exact inverse
  // of the splitHeading parseMd read it with, so a load/save round-trip changes nothing, down to
  // whether the note's first line sits under a blank one).
  const body = cardMarkdown(n);
  return `---\n${fm}\n---\n` + (body ? '\n' + body + '\n' : '\n');
}

// The markdown a node RENDERS — its whole note, title included.
//
// For a plain card that's `joinHeading(title, body)`: the title is the leading `# ` line of the text, and
// putting it back means renderBodyHTML makes it an H1 the same way it makes `- item` a bullet. There is no
// title element on a card any more, so this is the only place its name is drawn, and a card can't end up
// showing its name in one typeface in the row and another in the note.
// (An image card needs no arm of its own — it is untitled by definition, so joinHeading hands back the
// picture markdown unchanged.)
export function cardMarkdown(n: MindNode): string {
  return joinHeading(n.title, n.body, n.titleGap !== false);
}
// …and what a COLLAPSED node renders: the first line of that markdown, with `…` appended when anything
// follows it. Still MARKDOWN, fed to the same renderer, which is the whole point — `# Name` folds to a
// heading, `- milk` to a bullet, plain text to plain text, nothing restyled and nothing made bold.
//
// The `…` has to be put here rather than left to CSS, and the reason is a hard limit rather than a
// preference: `text-overflow` and `-webkit-line-clamp` can only ellipsise WITHIN one element. The text
// that a fold hides usually isn't in the same element — a heading followed by a paragraph, or several
// short lines that markdown makes into separate `<p>`s, are SIBLING blocks, and hiding a sibling
// truncates nothing the browser will mark. So CSS showed an ellipsis only when a single line happened to
// be too wide, which is the one case that needed it least. CSS still handles exactly that case (see
// styles.css) — this handles "there is more".
export function collapsedMarkdown(n: MindNode): string {
  const lines = cardMarkdown(n).split('\n');
  const i = firstTextLine(lines);
  return i < 0 ? '' : lines[i];
}
// How many non-blank lines a fold tucks away below the first one — the "N more lines" under it.
export function hiddenLineCount(n: MindNode): number {
  const lines = cardMarkdown(n).split('\n');
  const i = firstTextLine(lines);
  return i < 0 ? 0 : lines.slice(i + 1).filter(l => l.trim()).length;
}
