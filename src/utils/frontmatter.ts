// ============================================================
// Markdown frontmatter parse/serialize.
// Frontmatter is parsed as ORDERED entries so unknown keys round-trip untouched: each
// entry groups a top-level `key:` line with any following continuation lines (indented
// values, `- list` items, blanks, comments) until the next top-level key. This lets us
// rewrite ONLY the app-owned keys (tags/color/mm_*) while preserving everything else —
// `date`, `category`, `aliases`, custom fields, and the note body — verbatim.
// ============================================================
import { state, isBoxType, isImageCard, type MindNode, type NodeType, type NodeLayout, type FmEntry } from '../core/state.js';

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
  if (i < 0) return { title: '', body: '', gap: true };
  const h = headingOnLine(lines[i]);
  if (!h || !h.title) return { title: '', body: text.trim(), gap: true };
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
  if (!t) return b;
  return b ? `# ${t}\n${gap ? '\n' : ''}${b}` : `# ${t}`;
}
// A note's path -> its bare name, no directory and no `.md`. The title used to be read from exactly
// this, and it survives in two places for that reason: the one-shot migration of a body-less note
// (data/persistence.ts loadFromDir) and the last resort for SHOWING a name (utils/model.ts nodeLabel).
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
  let i = firstTextLine(lines); if (i < 0) i = 0;
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
    query: string;
    collapsed: boolean;
    locked: boolean;
    done: boolean;
    checklist: boolean;
    blank: boolean;      // mm_blank — this note is empty ON PURPOSE (see serializeMd)
    type: NodeType;
    layout: NodeLayout;
    side: string;
  };
}

function parseFM(fmText: string): FmEntry[] {
  const entries: FmEntry[] = [];
  for (const line of fmText.split('\n')){
    const m = line.match(/^([\w-]+):(.*)$/);
    if (m) entries.push({ key: m[1], lines: [line] });
    else if (entries.length) entries[entries.length-1].lines.push(line);   // continuation
    else entries.push({ key: null, lines: [line] });
  }
  return entries;
}
function fmEntry(entries: FmEntry[], key: string): FmEntry | undefined { return entries.find(e => e.key === key); }
function fmValue(entries: FmEntry[], key: string): string {
  const e = fmEntry(entries, key); if (!e) return '';
  return e.lines[0].slice(e.lines[0].indexOf(':')+1).trim();
}
function fmTags(entries: FmEntry[]): string[] {
  const e = fmEntry(entries, 'tags'); if (!e) return [];
  const inline = e.lines[0].slice(e.lines[0].indexOf(':')+1).trim();
  if (inline) return inline.replace(/^\[|\]$/g,'').split(',').map(s=>s.trim()).filter(Boolean);
  return e.lines.slice(1).map(l=>l.trim()).filter(l=>l.startsWith('-'))   // YAML list form
    .map(l=>l.replace(/^-\s*/,'').replace(/^["']|["']$/g,'').trim()).filter(Boolean);
}
function fmSet(entries: FmEntry[], key: string, line: string): void {
  const e = fmEntry(entries, key);
  if (e) e.lines = [line]; else entries.push({ key, lines:[line] });
}
function fmRemove(entries: FmEntry[], key: string): void {
  const i = entries.findIndex(e => e.key === key);
  if (i >= 0) entries.splice(i, 1);
}

// Resolve a note's kind + child-arrangement from frontmatter, folding legacy tokens.
// CURRENT format: `mm_type` (card|frame|stack|annotation|query, default card) + `mm_layout`.
// LEGACY (no mm_type): a single `mm_layout` token conflated both — split it here so old vaults
// keep working: none/''→card·inherit, free/line/fan→card·*, two-sided/grid→card·fan,
// frame(+mm_arrange flow-h/flow-v)→frame·free|horizontal|vertical, frame-h/-v→frame·*.
// `image` is folded away too, in BOTH spellings: there is no image kind any more — a card whose
// whole note is one `![alt](src)` renders as that picture (core/state.ts isImageCard), so an old
// image note is simply a card and keeps its mm_w/mm_h. The value stops being written on its
// first save; nothing else in the app has to know the kind ever existed.
function foldTypeLayout(entries: FmEntry[]): { type: NodeType; layout: NodeLayout } {
  const t = fmValue(entries, 'mm_type');
  if (t === 'image') return { type: 'card', layout: 'free' };
  if (t === 'frame' || t === 'stack' || t === 'card' || t === 'annotation' || t === 'query')
    return { type: t, layout: (fmValue(entries, 'mm_layout') || (t === 'frame' ? 'free' : 'inherit')) as NodeLayout };
  // legacy: infer both from the combined mm_layout token
  const v = fmValue(entries, 'mm_layout');
  if (v === 'image') return { type: 'card', layout: 'free' };
  if (v === 'frame' || v === 'frame-h' || v === 'frame-v') {
    let layout: NodeLayout = 'free';
    if (v === 'frame-h') layout = 'horizontal';
    else if (v === 'frame-v') layout = 'vertical';
    else {
      const a = fmValue(entries, 'mm_arrange');   // legacy free-frame flow marker
      if (a === 'flow-h') layout = 'horizontal';
      else if (a === 'flow-v') layout = 'vertical';
    }
    return { type: 'frame', layout };
  }
  if (v === 'two-sided' || v === 'grid') return { type: 'card', layout: 'fan' };
  // stack used to be a card LAYOUT before it became a node type — fold the old spelling over.
  if (v === 'stack') return { type: 'stack', layout: 'inherit' };
  // A card omits mm_type (card is the default), so a card's `mm_layout` is read HERE, not via the
  // mm_type branch above — every card layout value must be listed or it silently reverts to inherit.
  if (v === 'free' || v === 'line' || v === 'fan') return { type: 'card', layout: v };
  return { type: 'card', layout: 'inherit' };
}

export function parseMd(text: string): ParsedNote {
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
      query: fmValue(entries, 'mm_query'),
      collapsed: fmValue(entries, 'mm_collapsed') === 'true',
      locked: fmValue(entries, 'mm_locked') === 'true',
      done: fmValue(entries, 'mm_done') === 'true',
      checklist: fmValue(entries, 'mm_checklist') === 'true',
      blank: fmValue(entries, 'mm_blank') === 'true',
      ...foldTypeLayout(entries),
      // left | right | up | down | '' (unset — backfilled from position once loaded, see
      // data/persistence.ts). This is the CHILD's own attachment side, not the parent's.
      side: fmValue(entries, 'mm_side'),
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
  if (n.color) fmSet(entries, 'color', `color: ${n.color.startsWith('#') ? `"${n.color}"` : n.color}`);
  else fmRemove(entries, 'color');
  if (!fmEntry(entries, 'date')) entries.unshift({ key:'date', lines:[`date: ${todayISO()}`] });
  const parentNode = n.parent ? state.nodes.get(n.parent) ?? null : null;
  if (parentNode) entries.push({ key:'mm_parent', lines:[`mm_parent: ${parentNode.file}`] });
  if (parentNode && n.side) entries.push({ key:'mm_side', lines:[`mm_side: ${n.side}`] });
  // rx/ry is the parent-relative persisted form (see MindNode in core/state.ts); commitRel() has
  // refreshed it from x/y before we get here (saveAll / exportZip).
  entries.push({ key:'mm_position_x', lines:[`mm_position_x: ${Math.round(n.rx)}`] });
  entries.push({ key:'mm_position_y', lines:[`mm_position_y: ${Math.round(n.ry)}`] });
  if (n.collapsed) entries.push({ key:'mm_collapsed', lines:['mm_collapsed: true'] });
  if (n.locked) entries.push({ key:'mm_locked', lines:['mm_locked: true'] });
  if (n.done) entries.push({ key:'mm_done', lines:['mm_done: true'] });
  if (n.checklist) entries.push({ key:'mm_checklist', lines:['mm_checklist: true'] });
  // A note that is blank ON PURPOSE — the user cleared every character out of an existing card, which is
  // allowed and keeps the card's file, children and position (features/inline-edit.ts endBodyEdit). On
  // disk that is indistinguishable from a note written before titles moved into the body, whose name WAS
  // its filename and whose body was empty — and loadFromDir migrates that one by promoting the stem to a
  // heading, which would put the name the user just deleted straight back. Nothing else on disk can tell
  // the two apart (mm_position_x predates the title move by a hundred commits, so its presence says
  // nothing), so the blankness is STATED rather than inferred. Written only while there is nothing else to
  // write, and dropped again by the stale-mm_* sweep at the top as soon as anything is typed.
  if (!n.title.trim() && !n.body.trim()) entries.push({ key:'mm_blank', lines:['mm_blank: true'] });
  if (n.type !== 'card') entries.push({ key:'mm_type', lines:[`mm_type: ${n.type}`] });   // card is the default
  // Only card/frame carry a layout; omit it when it's the type's default (card→inherit, frame→free).
  // annotation/query are leaves with no layout, so they never write mm_layout.
  const layoutDefault = n.type === 'frame' ? 'free' : 'inherit';
  if ((n.type === 'card' || n.type === 'frame') && n.layout !== layoutDefault)
    entries.push({ key:'mm_layout', lines:[`mm_layout: ${n.layout}`] });
  // The AUTHORED width — every kind can carry one (a card/annotation/stack is resizable on this axis
  // alone). The HEIGHT belongs to the kinds that own a box, plus the one card that IS one: an IMAGE
  // card (core/state.ts isImageCard) is its picture, so both its axes are authored and its aspect is
  // what the resize locks. Any other card measures its height from its content and a stack derives its
  // own from its outline, so writing an mm_h for either would freeze a value they recompute anyway —
  // which is also why type-flipping a card out of image mode has to DROP the h (main.ts remeasure).
  if (n.w != null) entries.push({ key:'mm_w', lines:[`mm_w: ${Math.round(n.w)}`] });
  if ((isBoxType(n.type) || isImageCard(n)) && n.h != null) entries.push({ key:'mm_h', lines:[`mm_h: ${Math.round(n.h)}`] });
  if (n.type === 'query' && n.query) entries.push({ key:'mm_query', lines:[`mm_query: ${n.query}`] });
  const fm = entries.flatMap(e => e.lines).join('\n');
  // The title goes back where it lives: the body's leading heading (joinHeading — the exact inverse
  // of the splitHeading parseMd read it with, so a load/save round-trip changes nothing, down to
  // whether the note's first line sits under a blank one).
  const body = joinHeading(n.title, n.body, n.titleGap !== false);
  return `---\n${fm}\n---\n` + (body ? '\n' + body + '\n' : '\n');
}
