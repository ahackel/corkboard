// Frontmatter is parsed as ORDERED entries so unknown keys round-trip verbatim; only the app-owned
// keys (tags, color, mm_*) are ever rewritten.
import { type MindNode, type NodeType, type FmEntry } from '../core/state.js';

// The index of the first non-blank line, or -1.
export function firstTextLine(lines: string[]): number {
  return lines.findIndex(l => l.trim());
}

// A bare `# ` still matches (empty title): the editor needs to see a marker it may strip again.
export function headingOnLine(line: string): { markerLen: number; title: string; level: number } | null {
  const m = line.match(/^([^\S\n]*(#{1,6})[^\S\n]+)(.*\S)?[^\S\n]*$/);
  return m ? { markerLen: m[1].length, title: (m[3] ?? '').trim(), level: m[2].length } : null;
}

// The TITLE is the leading `#` line and nothing else: a note starting `- milk` is an untitled list.
// `gap`: whether a blank line separated heading and body, so joinHeading can round-trip it exactly.
export function splitHeading(text: string): { title: string; body: string; gap: boolean; level: number } {
  const lines = text.split('\n');
  const i = firstTextLine(lines);
  if (i < 0) {
    return { title: '', body: '', gap: true, level: 1 };
  }
  const h = headingOnLine(lines[i]);
  if (!h || !h.title) {
    return { title: '', body: text.trim(), gap: true, level: 1 };
  }
  const rest = lines.slice(i + 1);
  const body = rest.join('\n').trim();
  return { title: h.title, body, gap: body ? !rest[0]?.trim() : true, level: h.level };
}

// The exact inverse of splitHeading.
export function joinHeading(title: string, body: string, gap = true, level = 1): string {
  const t = title.trim(), b = body.trim();
  if (!t) {
    return b;
  }
  const head = '#'.repeat(level) + ' ' + t;
  return b ? `${head}\n${gap ? '\n' : ''}${b}` : head;
}

export function setNoteText(n: MindNode, text: string): void {
  const { title, body, gap, level } = splitHeading(text);
  n.title = title;
  n.body = body;
  n.titleGap = gap;
  n.titleLevel = level;
}

// Only for migrating body-less notes and as nodeLabel's last resort; never a title.
export function fileStem(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

// Deliberately WIDER than headingOnLine: mints a label from any first line, shorn of its marker.
const MARKER_RE = /^\s*(#{1,6}|[-*+]|>|\d+\.)\s*/;

// Kept apart from firstLineSplit so hot list paths don't rebuild a possibly long body.
export function firstLineLabel(text: string): string {
  const m = text.match(/^[^\S\n]*\S.*$/m);
  return m ? m[0].replace(MARKER_RE, '').trim() : '';
}

export function firstLineSplit(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  let i = firstTextLine(lines);
  if (i < 0) {
    i = 0;
  }
  return { title: (lines[i] ?? '').replace(MARKER_RE, '').trim(),
           body: lines.slice(i + 1).join('\n').trim() };
}

export interface ParsedNote {
  title: string;
  fmEntries: FmEntry[];
  color: string;
  tags: string[];
  body: string;
  titleGap: boolean;
  titleLevel: number;
  mm: {
    parent: string;
    px: number | null;   // mm_position_x/y, relative to the parent
    py: number | null;
    x: number | null;    // mm_x/mm_y, legacy absolute
    y: number | null;
    w: number | null;
    h: number | null;
    collapsed: boolean;
    locked: boolean;
    blank: boolean;
    type: NodeType;

    // A legacy stack's children were already INSIDE it, so the flatten migration keeps them nested.
    wasStack: boolean;
  };
}

// Any UNINDENTED `name:` is a key (`date created:`, `"my key":`). An unindented comment, or a blank
// line the value above doesn't continue past, belongs to the file rather than the key above.
const FM_KEY = /^(?![\s#-])([^:]+):(.*)$/;

function parseFM(fmText: string): FmEntry[] {
  const entries: FmEntry[] = [];
  const lines = fmText.split('\n');
  const continues = (i: number): boolean => {
    const next = lines.slice(i + 1).find(l => l.trim());
    return next !== undefined && /^[\s-]/.test(next);
  };
  lines.forEach((line, i) => {
    const m = line.match(FM_KEY);
    const apart = line.startsWith('#') || (!line.trim() && !continues(i));
    if (m) {
      entries.push({ key: m[1].trim().replace(/^(["'])(.*)\1$/, '$2'), lines: [line] });
    } else if (entries.length && entries[entries.length - 1].key !== null && !apart) {
      entries[entries.length-1].lines.push(line);   // continuation
    } else {
      entries.push({ key: null, lines: [line] });
    }
  });
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

// `[a, "b, c"] # x` → items `a`, `b, c` and comment `# x`. Quotes protect commas, brackets and `#`.
function flowItems(value: string): { items: string[]; comment: string } {
  const items: string[] = [];
  let cur = '', quote = '', i = 0;
  const list = value.startsWith('[');
  for (i = list ? 1 : 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else if (list ? ch === ']' : ch === '#' && !!cur.trim() && /\s/.test(value[i - 1])) {
      break;
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  const rest = value.slice(value[i] === ']' ? i + 1 : i).trim();
  return { items, comment: rest.startsWith('#') ? rest : '' };
}

// Obsidian also accepts a quoted `"#idea"`; the `#` is not part of the tag.
function fmTags(entries: FmEntry[]): string[] {
  const e = fmEntry(entries, 'tags');
  if (!e) {
    return [];
  }
  const inline = e.lines[0].slice(e.lines[0].indexOf(':')+1).trim();
  const bare = (s: string): string => s.trim().replace(/^["']|["']$/g,'').replace(/^#/,'').trim();
  if (inline) {
    return flowItems(inline).items.map(bare).filter(Boolean);
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

// Two kinds only. On disk a section is `mm_type: frame`; older kinds (image, stack, query, annotation)
// read as cards, and a legacy `mm_layout: frame*` (no mm_type) as a section.
function foldType(entries: FmEntry[]): { type: NodeType; wasStack: boolean } {
  const t = fmValue(entries, 'mm_type'), v = fmValue(entries, 'mm_layout');
  if (t === 'frame' || (!t && (v === 'frame' || v === 'frame-h' || v === 'frame-v'))) {
    return { type: 'section', wasStack: false };
  }
  return { type: 'card', wasStack: t === 'stack' || (!t && v === 'stack') };
}

export function parseMd(text: string): ParsedNote {
  // A missed frontmatter block (CRLF, BOM) would read as body and get a second block stacked on save.
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const entries = m ? parseFM(m[1]) : [];
  const { title, body, gap, level } = splitHeading(m ? m[2] : text);
  const num = (v: string): number | null => (v !== '' && !isNaN(+v)) ? +v : null;
  return {
    title,
    fmEntries: entries,

    // A custom hex is written quoted.
    color: fmValue(entries, 'color').replace(/^["']|["']$/g, ''),
    tags: fmTags(entries),
    body,
    titleGap: gap,
    titleLevel: level,

    // Legacy layout keys: read for migration, swept on the next write.
    mm: {
      parent: fmValue(entries, 'mm_parent'),
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

// Rewrites only the app-owned keys; writes nothing that says nothing, so a plain note is its text alone.
export function serializeMd(n: MindNode): string {
  const entries: FmEntry[] = (n.fmEntries || []).map(e => ({ key: e.key, lines: [...e.lines] }));
  entries.filter(e => e.key && e.key.startsWith('mm_')).forEach(e => fmRemove(entries, e.key as string));
  if (n.tags.length) {
    // Quote a tag YAML would misread; keep any trailing comment the line had.
    const was = fmEntry(entries, 'tags')?.lines[0] ?? '';
    const comment = flowItems(was.slice(was.indexOf(':') + 1).trim()).comment;
    const item = (t: string): string => /^[^\s,[\]{}#"'&*!|>%@`:-][^,[\]{}"']*$/.test(t) && !/\s#|:\s/.test(t) ? t : JSON.stringify(t);
    fmSet(entries, 'tags', `tags: [${n.tags.map(item).join(', ')}]${comment ? ' ' + comment : ''}`);
  } else {
    fmRemove(entries, 'tags');
  }

  // A bare `#ff8800` is a YAML comment, so a hex is quoted; palette keys stay bare.
  if (n.color) {
    fmSet(entries, 'color', `color: ${n.color.startsWith('#') ? `"${n.color}"` : n.color}`);
  } else {
    fmRemove(entries, 'color');
  }

  // Geometry and parent are not written: they live in board.json and the folder path.
  if (n.locked) {
    entries.push({ key:'mm_locked', lines:['mm_locked: true'] });
  }

  // See "A note that is blank ON PURPOSE says so" in docs/architecture.md: stops the load-time
  // migration from promoting the filename back into a title the user just deleted.
  if (!n.title.trim() && !n.body.trim()) {
    entries.push({ key:'mm_blank', lines:['mm_blank: true'] });
  }
  if (n.type !== 'card') {
    entries.push({ key:'mm_type', lines:['mm_type: frame'] });
  }
  const fm = entries.flatMap(e => e.lines).join('\n');
  const body = cardMarkdown(n);

  // A body opening on `---` still needs an (empty) block, or it would read as one.
  if (!entries.length && !/^---\s*(\n|$)/.test(body)) {
    return body ? body + '\n' : '';
  }
  return `---\n${fm}\n---\n` + (body ? '\n' + body + '\n' : '\n');
}

// The markdown a node renders: its whole note, title included.
export function cardMarkdown(n: MindNode): string {
  return joinHeading(n.title, n.body, n.titleGap !== false, n.titleLevel ?? 1);
}

// The `…` of a fold can't be CSS: text-overflow only ellipsises within ONE element, and the hidden
// text is usually a sibling block.
export function collapsedMarkdown(n: MindNode): string {
  const lines = cardMarkdown(n).split('\n');
  const i = firstTextLine(lines);
  return i < 0 ? '' : lines[i];
}

export function hiddenLineCount(n: MindNode): number {
  const lines = cardMarkdown(n).split('\n');
  const i = firstTextLine(lines);
  return i < 0 ? 0 : lines.slice(i + 1).filter(l => l.trim()).length;
}

// `at` is the title's offset into the WHOLE text (a caret offset); the note may open on blank lines.
export function headingOf(text: string): { at: number; title: string } | null {
  const lines = text.split('\n');
  const i = firstTextLine(lines);
  if (i < 0) {
    return null;
  }
  const h = headingOnLine(lines[i]);
  if (!h) {
    return null;
  }
  let start = 0;
  for (let k = 0; k < i; k++) {
    start += lines[k].length + 1;
  }
  return { at: start + h.markerLen, title: h.title };
}

// 'title' selects the name but not its `# `, or the first keystroke would demote it to plain text.
export function caretIn(text: string, caret: 'title' | 'end'): [number, number] {
  if (caret === 'end') {
    return [text.length, text.length];
  }
  const h = headingOf(text);
  if (!h) {
    return [0, 0];
  }
  return [h.at, h.at + h.title.length];
}
