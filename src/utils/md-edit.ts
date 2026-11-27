// The note editor's smart keys as pure text → text edits (pinned by tests/). Each returns the whole new
// text and selection, or null to let the key act natively.
import { escRe } from './markdown.js';
import { lineAt, type TextEdit } from './text-edit.js';
import { tableTab, tableEdit, insertTable, tableRowsMayMove, type TableOp } from './md-table.js';
import { TYPING_TAG } from './tags.js';

// Also matches `1)`, which paste-list.ts reads too.
const ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
interface Item { indent: string; marker: string; gap: string; task: string; lead: number }

function itemOf(line: string): Item | null {
  const m = line.match(ITEM);
  return m ? { indent: m[1], marker: m[2], gap: m[3], task: m[4] ?? '', lead: m[0].length } : null;
}

const splice = (text: string, from: number, to: number, insert: string): string =>
  text.slice(0, from) + insert + text.slice(to);

// Enter continues a list item (next number, a fresh `[ ] `); on an empty item it ENDS the list, as
// Obsidian and GitHub do.
export function listEnter(text: string, start: number, end: number): TextEdit | null {
  if (start !== end) {
    return null;
  }
  const { from, to } = lineAt(text, start);
  const it = itemOf(text.slice(from, to));
  if (!it || start < from + it.lead) {
    return null;
  }
  if (!text.slice(from + it.lead, to).trim()) {
    return { text: splice(text, from, to, ''), start: from, end: from };
  }
  const num = it.marker.match(/^(\d+)([.)])$/);
  const marker = num ? `${+num[1] + 1}${num[2]}` : it.marker;
  const ins = '\n' + it.indent + marker + it.gap + (it.task ? '[ ] ' : '');
  return { text: splice(text, start, start, ins), start: start + ins.length, end: start + ins.length };
}

// One step IN is the width of the marker above (`- ` 2, `1. ` 3), the column CommonMark needs to read
// nesting. Never null: Tab must not move focus off the card mid-sentence.
export function indentLines(text: string, start: number, end: number, out: boolean): TextEdit {
  const first = lineAt(text, start).from;

  // A selection ending at a line's very start doesn't touch that line.
  const last = lineAt(text, end > start && text[end - 1] === '\n' ? end - 1 : end).to;
  const lines = text.slice(first, last).split('\n');
  const width = (s: string) => s.replace(/\t/g, '  ').length;
  const lead0 = width(lines[0].match(/^[ \t]*/)![0]);

  // The list items above, nearest first.
  const above = text.slice(0, first).split('\n').reverse().map(itemOf).filter((x): x is Item => !!x);
  let step: number;
  if (!out) {
    const sib = above.find(x => width(x.indent) <= lead0);
    step = sib && width(sib.indent) === lead0 ? sib.marker.length + sib.gap.length : 2;
  } else {
    const parent = above.find(x => width(x.indent) < lead0);
    step = parent ? lead0 - width(parent.indent) : lead0;
  }
  let delta0 = 0, deltaAll = 0;
  const next = lines.map((l, i) => {
    const lead = l.match(/^[ \t]*/)![0];
    let nl: string;
    if (!out) {
      nl = l.trim() || lines.length === 1 ? ' '.repeat(step) + l : l;   // blank lines stay blank
    } else {
      nl = ' '.repeat(Math.max(0, width(lead) - step)) + l.slice(lead.length);
    }
    if (i === 0) {
      delta0 = nl.length - l.length;
    }
    deltaAll += nl.length - l.length;
    return nl;
  });
  const t = splice(text, first, last, next.join('\n'));

  // The selection's start is clamped so an outdent can't pull it onto the line above.
  const s = Math.max(first, start + delta0);
  return { text: t, start: s, end: start === end ? s : Math.max(s, end + deltaAll) };
}

// Wrap in `**`/`*`/`~~`, or unwrap if already wrapped (markers outside or inside the selection). A
// marker run is read whole, so ⌘I inside `**bold**` gives `***bold***`. Caught whitespace stays outside.
export function toggleWrap(text: string, start: number, end: number, mark: string): TextEdit {
  const ch = mark[0];
  const holds = (run: number) => run === mark.length || (ch === '*' && run === 3);
  const runBack = (at: number) => {
    let n = 0;
    while (at - n - 1 >= 0 && text[at - n - 1] === ch) {
      n++;
    }
    return n;
  };
  const runFwd = (at: number) => {
    let n = 0;
    while (text[at + n] === ch) {
      n++;
    }
    return n;
  };
  const L = mark.length;
  if (start === end) {
    if (runBack(start) === L && runFwd(start) === L) {
      return { text: splice(text, start - L, start + L, ''), start: start - L, end: start - L };   // undo an empty pair
    }
    return { text: splice(text, start, start, mark + mark), start: start + L, end: start + L };
  }
  const sel = text.slice(start, end);
  const a = start + (sel.length - sel.trimStart().length);
  const b = end - (sel.length - sel.trimEnd().length);
  if (a >= b) {
    return { text, start, end };
  }

    // Markers just OUTSIDE the selection.
  if (holds(runBack(a)) && holds(runFwd(b))) {
    const t = splice(splice(text, b, b + L, ''), a - L, a, '');
    return { text: t, start: a - L, end: b - L };
  }

    // Markers INSIDE it (the whole `**word**` selected).
  const inner = text.slice(a, b);
  let lead = 0;
  while (inner[lead] === ch) {
    lead++;
  }
  let trail = 0;
  while (trail < inner.length - lead && inner[inner.length - 1 - trail] === ch) {
    trail++;
  }
  if (inner.length > 2 * L && holds(lead) && holds(trail) && lead === trail) {
    const t = splice(splice(text, b - L, b, ''), a, a + L, '');
    return { text: t, start: a, end: b - 2 * L };
  }
  const t = splice(text, a, b, mark + inner + mark);
  return { text: t, start: a + L, end: b + L };
}

// A position past a line's indent moves by however much that line grew or shrank ahead of it.
function rewriteLines(text: string, first: number, last: number, next: string[], start: number, end: number): TextEdit {
  const old = text.slice(first, last).split('\n');
  const map = (pos: number): number => {
    let o = first, n = first;
    for (let i = 0; i < old.length; i++) {
      if (pos <= o + old[i].length) {
        const col = pos - o, ind = old[i].match(/^[ \t]*/)![0].length;
        return n + (col <= ind ? col : Math.max(ind, col + next[i].length - old[i].length));
      }
      o += old[i].length + 1; n += next[i].length + 1;
    }
    return pos + (n - o);
  };
  return { text: splice(text, first, last, next.join('\n')), start: map(start), end: map(end) };
}

// [from, to); a selection ending at a line's very start leaves that line out.
function linesOf(text: string, start: number, end: number): { first: number; last: number } {
  return { first: lineAt(text, start).from, last: lineAt(text, end > start && text[end - 1] === '\n' ? end - 1 : end).to };
}
const indentOf = (l: string): number => l.match(/^[ \t]*/)![0].replace(/\t/g, '  ').length;


// Backspace after a marker takes the whole MARKER: a nested item steps out, a top-level one becomes plain.
export function listBackspace(text: string, start: number, end: number): TextEdit | null {
  if (start !== end) {
    return null;
  }
  const { from, to } = lineAt(text, start);
  const it = itemOf(text.slice(from, to));
  if (!it || start !== from + it.lead) {
    return null;
  }
  if (it.indent) {
    return indentLines(text, start, end, true);
  }
  return { text: splice(text, from, start, ''), start: from, end: from };
}


// An item travels WITH its children and hops a whole neighbouring item rather than landing inside it.
export function moveLines(text: string, start: number, end: number, up: boolean): TextEdit | null {
  if (!tableRowsMayMove(text, start, end, up)) {
    return null;
  }
  const lines = text.split('\n');
  const lineNo = (pos: number) => text.slice(0, pos).split('\n').length - 1;
  const blank = (i: number) => !lines[i].trim();
  const a = lineNo(start);
  let b = lineNo(end > start && text[end - 1] === '\n' ? end - 1 : end);
  const own = lines.slice(a, b + 1).filter(l => l.trim());
  const base = own.length ? Math.min(...own.map(indentOf)) : 0;
  while (own.length && b + 1 < lines.length && !blank(b + 1) && indentOf(lines[b + 1]) > base) {
    b++;
  }
  let lo: number, hi: number;                           // the neighbouring unit, lines [lo, hi]
  if (up) {
    if (a === 0) {
      return null;
    }
    hi = a - 1; lo = hi;
    let k = hi;
    while (k >= 0 && !blank(k) && indentOf(lines[k]) > base) {
      k--;
    }
    if (k >= 0 && k < hi && !blank(k)) {
      lo = k;          // the item above, with the children we're under
    }
  } else {
    if (b === lines.length - 1) {
      return null;
    }
    lo = b + 1; hi = lo;
    if (!blank(lo)) {
      while (hi + 1 < lines.length && !blank(hi + 1) && indentOf(lines[hi + 1]) > indentOf(lines[lo])) {
        hi++;
      }
    }
  }
  const block = lines.slice(a, b + 1), unit = lines.slice(lo, hi + 1);
  const shift = unit.join('\n').length + 1;
  const out = up ? [...lines.slice(0, lo), ...block, ...unit, ...lines.slice(b + 1)]
                 : [...lines.slice(0, a), ...unit, ...block, ...lines.slice(hi + 1)];
  const d = up ? -shift : shift;
  return { text: out.join('\n'), start: start + d, end: end + d };
}

// All tasks flip together (all done → all open, else all done); otherwise non-tasks get a box. Headings
// are left alone: the first one is the card's title.
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;

export function taskLines(text: string, start: number, end: number): TextEdit {
  const { first, last } = linesOf(text, start, end);
  const lines = text.slice(first, last).split('\n');
  const use = lines.map(l => (!!l.trim() || lines.length === 1) && !HEADING.test(l));
  const items = lines.map(itemOf);
  const allTasks = use.some(Boolean) && lines.every((_, i) => !use[i] || !!items[i]?.task);
  const allDone = allTasks && lines.every((_, i) => !use[i] || /x/i.test(items[i]!.task));
  const next = lines.map((l, i) => {
    const it = items[i];
    if (!use[i]) {
      return l;
    }
    if (allTasks) {
      const p = it!.indent.length + it!.marker.length + it!.gap.length;
      return l.slice(0, p) + (allDone ? '[ ]' : '[x]') + l.slice(p + 3);
    }
    if (it?.task) {
      return l;
    }
    if (it) {
      return l.slice(0, it.lead) + '[ ] ' + l.slice(it.lead);
    }
    const ind = l.match(/^[ \t]*/)![0];
    return ind + '- [ ] ' + l.slice(ind.length);
  });
  if (lines.length === 1 && !lines[0].trim() && use[0]) {               // an empty line: caret after the new box
    const at = first + next[0].length;
    return { text: splice(text, first, last, next[0]), start: at, end: at };
  }
  return rewriteLines(text, first, last, next, start, end);
}

// Renumbers only the run of non-blank lines around the edit, so a list elsewhere that skips on purpose
// is untouched. A top-level list keeps its start (`5.`); a NESTED one counts from 1.
const ORDERED = /^([ \t]*)(\d+)([.)])(?=[ \t])/;

export function renumber(r: TextEdit): TextEdit {
  const lines = r.text.split('\n');
  let li = r.text.slice(0, r.start).split('\n').length - 1;
  if (!lines[li].trim() && li > 0) {
    li--;
  }
  if (!lines[li].trim()) {
    return r;
  }
  let a = li, b = li;
  while (a > 0 && lines[a - 1].trim()) {
    a--;
  }
  while (b + 1 < lines.length && lines[b + 1].trim()) {
    b++;
  }
  const counters = new Map<number, { n: number; d: string }>();
  const next = lines.slice(a, b + 1).map(l => {
    const w = indentOf(l), m = l.match(ORDERED);
    const outer = [...counters.keys()].some(k => k < w);
    for (const k of [...counters.keys()]) {
      if (k > w || (k === w && !m)) {
        counters.delete(k);
      }
    }
    if (!m) {
      return l;
    }
    const c = counters.get(w);
    let num: number;
    if (c && c.d === m[3]) {
      num = c.n++;
    } else {
      num = outer ? 1 : +m[2];
      counters.set(w, { n: num + 1, d: m[3] });
    }
    return m[1] + num + l.slice(m[1].length + m[2].length);
  });
  let first = 0;
  for (let k = 0; k < a; k++) {
    first += lines[k].length + 1;
  }
  const last = first + lines.slice(a, b + 1).join('\n').length;
  if (next.join('\n') === lines.slice(a, b + 1).join('\n')) {
    return r;
  }
  return rewriteLines(r.text, first, last, next, r.start, r.end);
}
export const renumbered = (r: TextEdit | null): TextEdit | null => r && renumber(r);

// Double-click lands where you clicked: each rendered text node is found in the source after the
// previous one (whitespace may differ), and the click offset maps into its match. Null if not found.
export function sourceOffset(source: string, from: number, texts: string[], hit: number, off: number): number | null {
  let cur = from;
  for (let i = 0; i <= hit; i++) {
    const t = texts[i], s = t.trim();
    if (!s) {
      if (i === hit) {
        return cur;
      }
      continue;
    }
    const re = new RegExp(escRe(s).replace(/\s+/g, '\\s+'), 'g');
    re.lastIndex = cur;
    const m = re.exec(source);
    if (!m) {
      if (i === hit) {
        return null;
      }
      continue;
    }
    if (i === hit) {

      // A whitespace run in the rendered text matches a whitespace run in the source.
      const k = Math.max(0, Math.min(s.length, off - (t.length - t.trimStart().length)));
      let x = 0, y = 0;
      while (x < k) {
        if (/\s/.test(s[x])) {
          while (x < k && /\s/.test(s[x])) {
            x++;
          }
          while (y < m[0].length && /\s/.test(m[0][y])) {
            y++;
          }
        }
        else { x++; y++; }
      }
      return m.index + y;
    }
    cur = m.index + m[0].length;
  }
  return null;
}

// From the heading line to before the next heading of the same or higher level, less trailing blanks.
export function headingSection(text: string, pos: number): { start: number; end: number } | null {
  const level = (l: string): number => {
    const m = /^ {0,3}(#{1,6})(?:\s|$)/.exec(l);
    return m ? m[1].length : 0;
  };
  const { from, to } = lineAt(text, pos);
  const own = level(text.slice(from, to));
  if (!own) {
    return null;
  }
  let end = text.length;
  for (let at = to + 1; at < text.length; ) {
    const next = text.indexOf('\n', at);
    const lineEnd = next < 0 ? text.length : next;
    const l = level(text.slice(at, lineEnd));
    if (l && l <= own) {
      end = at;
      break;
    }
    at = lineEnd + 1;
  }
  while (end > to && /\s/.test(text[end - 1])) {
    end--;
  }
  return { start: from, end };
}

// `[[Pla|` is a link being typed, `#proj|` a tag; `from` is where the name starts. Never inside code, and
// a link stops at `|`, `#` or `^`.
export interface Completing { kind: 'link' | 'tag'; from: number; query: string }

export function completingAt(text: string, caret: number): Completing | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1, before = text.slice(lineStart, caret);
  const fences = text.slice(0, lineStart).split('\n').filter(l => /^(```|~~~)/.test(l)).length;
  if (fences % 2 || (before.match(/`/g) ?? []).length % 2) {
    return null;
  }
  const link = before.match(/\[\[([^[\]|#^]*)$/);
  if (link) {
    return { kind: 'link', from: caret - link[1].length, query: link[1] };
  }
  const tag = before.match(TYPING_TAG);
  return tag ? { kind: 'tag', from: caret - tag[1].length, query: tag[1] } : null;
}

// A link gets CLOSED with `]]` unless it already was; a tag gets a trailing space unless one is there.
export function completeAt(text: string, c: Completing, caret: number, choice: string): TextEdit {
  if (c.kind === 'link') {
    const ins = choice + ']]', rest = text.slice(caret);
    const at = c.from + ins.length;
    return { text: text.slice(0, c.from) + ins + (rest.startsWith(']]') ? rest.slice(2) : rest), start: at, end: at };
  }
  const rest = text.slice(caret), ins = choice + (/^\s/.test(rest) ? '' : ' ');
  const at = c.from + ins.length;
  return { text: text.slice(0, c.from) + ins + rest, start: at, end: at };
}

// Opens the completion list on the selection. A tag's `#` needs a space before it, so one is added.
export function startCompletion(text: string, start: number, end: number, mark: '[[' | '#'): TextEdit {
  const lead = mark === '#' && start > 0 && !/[\s([{,;]/.test(text[start - 1]) ? ' ' + mark : mark;
  const at = end + lead.length;
  return { text: splice(text, start, start, lead), start: at, end: at };
}

// The Format submenu. Each edit acts on the lines the selection touches.

// Any stack of leads (`> - [ ] x`), so a new format REPLACES the old one rather than stacking on it.
const LEAD = /^(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/;

function stripLeads(line: string): { indent: string; rest: string } {
  const indent = line.match(/^[ \t]*/)![0];
  let rest = line.slice(indent.length), m: RegExpMatchArray | null;
  while ((m = rest.match(LEAD))) {
    rest = rest.slice(m[0].length);
  }
  return { indent, rest };
}
export type Block = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'bullet' | 'number' | 'quote' | 'body';

function blockOf(line: string): Block {
  const h = line.match(/^ {0,3}(#{1,6})[ \t]/);
  if (h) {
    return `h${h[1].length}` as Block;
  }
  if (/^\s*>/.test(line)) {
    return 'quote';
  }
  const it = itemOf(line);
  return !it || it.task ? 'body' : /\d/.test(it.marker) ? 'number' : 'bullet';
}

// Picking the format all lines already have reverts them to body. A list keeps each line's indent.
export function setBlock(text: string, start: number, end: number, kind: Block): TextEdit {
  const { first, last } = linesOf(text, start, end);
  const lines = text.slice(first, last).split('\n');
  const use = lines.map(l => !!l.trim() || lines.length === 1);
  const to = use.some(Boolean) && lines.every((l, i) => !use[i] || blockOf(l) === kind) ? 'body' : kind;
  const count = new Map<string, number>();       // a numbered list counts per nesting level, anew after a gap
  const next = lines.map((l, i) => {
    if (!use[i]) {
      count.clear();
      return l;
    }
    const { indent, rest } = stripLeads(l);
    if (to === 'bullet') {
      return indent + '- ' + rest;
    }
    if (to === 'number') {
      const k = (count.get(indent) ?? 0) + 1;
      count.set(indent, k);
      return indent + `${k}. ` + rest;
    }
    if (to === 'quote') {
      return '> ' + rest;
    }
    return to === 'body' ? rest : '#'.repeat(Number(to[1])) + ' ' + rest;
  });
  if (lines.length === 1) {                       // the caret goes past the new lead
    const at = first + next[0].length;
    return renumber({ text: splice(text, first, last, next[0]), start: at, end: at });
  }
  return renumber({ text: splice(text, first, last, next.join('\n')), start: first, end: first + next.join('\n').length });
}

// Fences the touched lines, or removes fences already there (inside or just outside the selection).
const FENCE = /^(```|~~~)/;

export function codeBlock(text: string, start: number, end: number): TextEdit {
  const { first, last } = linesOf(text, start, end);
  const body = text.slice(first, last);
  const lines = body.split('\n');
  if (lines.length >= 2 && FENCE.test(lines[0]) && FENCE.test(lines[lines.length - 1])) {
    const inner = lines.slice(1, -1).join('\n');
    return { text: splice(text, first, last, inner), start: first, end: first + inner.length };
  }
  const above = first > 0 ? lineAt(text, first - 1) : null;
  const below = last < text.length ? lineAt(text, last + 1) : null;
  if (above && below && FENCE.test(text.slice(above.from, above.to)) && FENCE.test(text.slice(below.from, below.to))) {
    const out = text.slice(0, above.from) + body + text.slice(below.to);
    return { text: out, start: above.from, end: above.from + body.length };
  }
  const at = first + 4;
  return { text: splice(text, first, last, '```\n' + body + '\n```'), start: at, end: at + body.length };
}

export function insertLink(text: string, start: number, end: number): TextEdit {
  const sel = text.slice(start, end);
  const out = splice(text, start, end, `[${sel}]()`);
  const at = sel ? start + sel.length + 3 : start + 1;
  return { text: out, start: at, end: at };
}

// `---` right under text would be a setext HEADING, so a blank line goes above.
export function insertRule(text: string, _start: number, end: number): TextEdit {
  const { from, to } = lineAt(text, end);
  const blank = !text.slice(from, to).trim();
  const prev = blank && from > 0 ? lineAt(text, from - 1) : null;
  const pre = blank ? (prev && text.slice(prev.from, prev.to).trim() ? '\n' : '') : '\n\n';
  const at = blank ? from : to;
  const head = text.slice(0, at) + pre + '---';
  const tail = text.slice(to);
  const out = head + (tail.startsWith('\n') ? tail : '\n' + tail);
  return { text: out, start: head.length + 1, end: head.length + 1 };
}

// Inline marks only, including those just OUTSIDE the selection; block leads are Body's job.
const MARK = '*_~=`';

export function clearStyles(text: string, start: number, end: number): TextEdit {
  let a = start, b = end;
  if (a === b) {
    ({ from: a, to: b } = lineAt(text, a));
  }
  while (a > 0 && b < text.length && MARK.includes(text[a - 1]) && text[a - 1] === text[b]) {
    a--;
    b++;
  }
  let s = text.slice(a, b), was: string;
  do {
    was = s;
    s = s.replace(/(\*\*|__|~~|==)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(^|[^*\w])\*(?=[^*\s])([^*\n]*?)(?<=\S)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^_\w])_(?=[^_\s])([^_\n]*?)(?<=\S)_(?!\w)/g, '$1$2');
  } while (s !== was);
  return { text: splice(text, a, b, s), start: a, end: a + s.length };
}

// ONE list for the editor's keys and its right-click menu, so they can't drift. A command whose edit
// returns null at the caret shows greyed out.
export interface EditKey { key: string; mod?: boolean; shift?: boolean; alt?: boolean }
export interface EditCommand {
  id: string;
  label: string;
  shortcut?: string;                   // the ⌘ spelling; keys() makes it Ctrl+ elsewhere
  key?: EditKey;
  edit: (text: string, start: number, end: number) => TextEdit | null;
}
const block = (id: Block, label: string): EditCommand => ({ id, label, edit: (v, a, b) => setBlock(v, a, b, id) });
const table = (op: TableOp, label: string): EditCommand => ({ id: `table-${op}`, label, edit: (v, a) => tableEdit(v, a, op) });
export const EDIT_COMMANDS: EditCommand[] = [
  { id: 'bold', label: 'Bold', shortcut: '⌘B', key: { key: 'b', mod: true }, edit: (v, a, b) => toggleWrap(v, a, b, '**') },
  { id: 'italic', label: 'Italic', shortcut: '⌘I', key: { key: 'i', mod: true }, edit: (v, a, b) => toggleWrap(v, a, b, '*') },
  { id: 'strike', label: 'Strikethrough', shortcut: '⌘⇧X', key: { key: 'x', mod: true, shift: true },
    edit: (v, a, b) => toggleWrap(v, a, b, '~~') },
  { id: 'highlight', label: 'Highlight', edit: (v, a, b) => toggleWrap(v, a, b, '==') },
  { id: 'code', label: 'Code', edit: (v, a, b) => toggleWrap(v, a, b, '`') },
  { id: 'task', label: 'Task / tick it', shortcut: '⌘L', key: { key: 'l', mod: true }, edit: taskLines },
  { id: 'indent', label: 'Indent', shortcut: 'Tab', key: { key: 'tab' },
    edit: (v, a, b) => tableTab(v, a, b, false) ?? renumbered(indentLines(v, a, b, false)) },
  { id: 'outdent', label: 'Outdent', shortcut: '⇧Tab', key: { key: 'tab', shift: true },
    edit: (v, a, b) => tableTab(v, a, b, true) ?? renumbered(indentLines(v, a, b, true)) },
  { id: 'up', label: 'Move line up', shortcut: '⌥↑', key: { key: 'arrowup', alt: true },
    edit: (v, a, b) => renumbered(moveLines(v, a, b, true)) },
  { id: 'down', label: 'Move line down', shortcut: '⌥↓', key: { key: 'arrowdown', alt: true },
    edit: (v, a, b) => renumbered(moveLines(v, a, b, false)) },
  block('h1', 'Heading 1'), block('h2', 'Heading 2'), block('h3', 'Heading 3'),
  block('h4', 'Heading 4'), block('h5', 'Heading 5'), block('h6', 'Heading 6'),
  block('bullet', 'Bulleted list'), block('number', 'Numbered list'), block('quote', 'Blockquote'), block('body', 'Body'),
  { id: 'codeblock', label: 'Code block', edit: codeBlock },
  { id: 'table', label: 'Add table', edit: insertTable },
  { id: 'link', label: 'Add link', edit: insertLink },
  { id: 'rule', label: 'Add horizontal rule', edit: insertRule },
  { id: 'clear', label: 'Clear styles', edit: clearStyles },
  table('sortAsc', 'Sort column ascending'), table('sortDesc', 'Sort column descending'),
  table('rowAbove', 'Add row above'), table('rowBelow', 'Add row below'),
  table('colBefore', 'Add column before'), table('colAfter', 'Add column after'),
  table('alignLeft', 'Align column left'), table('alignCenter', 'Align column center'), table('alignRight', 'Align column right'),
  table('deleteCol', 'Delete column'), table('deleteRow', 'Delete row'),
  table('colLeft', 'Move column left'), table('colRight', 'Move column right'),
  table('rowUp', 'Move row up'), table('rowDown', 'Move row down'),
  table('reformat', 'Reformat table'), table('transpose', 'Transpose rows and columns'),
];

// ⌘ and Ctrl both count as mod; the other modifiers must match exactly.
export function editCommandFor(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): EditCommand | null {
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
  return EDIT_COMMANDS.find(({ key: c }) => c && c.key === k && !!c.mod === mod && !!c.shift === e.shiftKey && !!c.alt === e.altKey) ?? null;
}
