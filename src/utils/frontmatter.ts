// ============================================================
// Markdown frontmatter parse/serialize.
// Frontmatter is parsed as ORDERED entries so unknown keys round-trip untouched: each
// entry groups a top-level `key:` line with any following continuation lines (indented
// values, `- list` items, blanks, comments) until the next top-level key. This lets us
// rewrite ONLY the app-owned keys (tags/color/mm_*) while preserving everything else —
// `date`, `category`, `aliases`, custom fields, and the note body — verbatim.
// ============================================================
import { state, isBoxType, type MindNode, type NodeType, type NodeLayout, type FmEntry } from '../core/state.js';

// ---------- a note's TITLE is the leading heading of its body ----------
// `# Notes` on the first non-blank line IS the title, and nothing else is. Not a frontmatter key,
// and NOT the filename: the filename is a derived slug that may carry a ` 2` suffix to stay unique
// on disk, so reading the title back off it would put that suffix into the title. Storing it as the
// body's first line instead means duplicate titles need no new frontmatter key at all — and it's
// what a Markdown author writes anyway, so the file reads correctly in Obsidian and every other
// renderer.
// NO heading means the card is UNTITLED — a sticky note that is only its text. That's why this tests
// for `#` alone: firstLineLabel (features/crud.ts) also strips bullets, quotes and list numbers,
// which is right when minting a label out of arbitrary dragged text and wrong here — a note starting
// `- milk` is a list, not a card titled "milk".
export function splitHeading(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  const i = lines.findIndex(l => l.trim());
  if (i < 0) return { title: '', body: '' };
  const m = lines[i].match(/^\s*#{1,6}\s+(.*\S)\s*$/);
  if (!m) return { title: '', body: text.trim() };
  return { title: m[1].trim(), body: lines.slice(i + 1).join('\n').trim() };
}
// …and back. The inverse of splitHeading, so a load/save round-trip is a no-op: an untitled note is
// its body alone, and a titled one gets its heading back as the first line.
export function joinHeading(title: string, body: string): string {
  const t = title.trim(), b = body.trim();
  if (!t) return b;
  return b ? `# ${t}\n\n${b}` : `# ${t}`;
}
// A human LABEL off the first non-blank line of arbitrary text, shorn of whatever markdown marker
// introduced it — a heading's #, a bullet, a quote, a list number. Deliberately WIDER than
// splitHeading, and the two must not be confused: this mints a name for something that hasn't got
// one (an untitled card's filename slug, the text-drag ghost's caption), where any first line will
// do; splitHeading answers the FORMAT question "does this note carry a title", which only `#` may
// answer — or a note beginning `- milk` would be a card titled "milk" instead of a list.
// A note's path -> its bare name, no directory and no `.md`. The title used to be read from exactly
// this, and it survives in two places for that reason: the one-shot migration of a body-less note
// (data/persistence.ts loadFromDir) and the last resort for SHOWING a name (utils/model.ts nodeLabel).
export function fileStem(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}
export function firstLineLabel(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  let i = lines.findIndex(l => l.trim()); if (i < 0) i = 0;
  return { title: (lines[i] ?? '').replace(/^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/, '').trim(),
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
// CURRENT format: `mm_type` (card|frame|image, default card) + `mm_layout` (the arrangement).
// LEGACY (no mm_type): a single `mm_layout` token conflated both — split it here so old vaults
// keep working: none/''→card·inherit, free/line/fan→card·*, two-sided/grid→card·fan,
// frame(+mm_arrange flow-h/flow-v)→frame·free|horizontal|vertical, frame-h/-v→frame·*, image→image.
function foldTypeLayout(entries: FmEntry[]): { type: NodeType; layout: NodeLayout } {
  const t = fmValue(entries, 'mm_type');
  if (t === 'frame' || t === 'stack' || t === 'image' || t === 'card' || t === 'annotation' || t === 'query')
    return { type: t, layout: (fmValue(entries, 'mm_layout') || (t === 'frame' ? 'free' : 'inherit')) as NodeLayout };
  // legacy: infer both from the combined mm_layout token
  const v = fmValue(entries, 'mm_layout');
  if (v === 'image') return { type: 'image', layout: 'free' };
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
  const { title, body } = splitHeading(m ? m[2] : text);
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
  const parentNode = n.parent ? state.nodes.get(n.parent) : null;
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
  if (n.type !== 'card') entries.push({ key:'mm_type', lines:[`mm_type: ${n.type}`] });   // card is the default
  // Only card/frame carry a layout; omit it when it's the type's default (card→inherit, frame→free).
  // image/annotation are leaves with no layout, so they never write mm_layout.
  const layoutDefault = n.type === 'frame' ? 'free' : 'inherit';
  if ((n.type === 'card' || n.type === 'frame') && n.layout !== layoutDefault)
    entries.push({ key:'mm_layout', lines:[`mm_layout: ${n.layout}`] });
  // The AUTHORED width — every kind can carry one (a card/annotation/stack is resizable on this axis
  // alone). The HEIGHT is box-kinds-only: a card measures its own from its content and a stack derives
  // its own from its outline, so writing an mm_h for either would freeze a value they recompute anyway.
  if (n.w != null) entries.push({ key:'mm_w', lines:[`mm_w: ${Math.round(n.w)}`] });
  if (isBoxType(n.type) && n.h != null) entries.push({ key:'mm_h', lines:[`mm_h: ${Math.round(n.h)}`] });
  if (n.type === 'query' && n.query) entries.push({ key:'mm_query', lines:[`mm_query: ${n.query}`] });
  const fm = entries.flatMap(e => e.lines).join('\n');
  // The title goes back where it lives: the body's leading heading (joinHeading — the exact inverse
  // of the splitHeading parseMd read it with, so a load/save round-trip changes nothing).
  const body = joinHeading(n.title, n.body);
  return `---\n${fm}\n---\n` + (body ? '\n' + body + '\n' : '\n');
}
