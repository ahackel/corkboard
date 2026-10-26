// ---------- writing markdown in the card's textarea ----------
// The small set of things a note editor does FOR you, as pure text → text functions so tests/ pins
// them without a browser: a list that continues itself on Enter, Tab/⇧Tab nesting list items, and
// ⌘B/⌘I/⌘⇧X wrapping the selection. Each returns the WHOLE new text plus where the selection lands
// (the same shape as utils/markdown.ts linkPaste), or null to let the key do what it natively does.
// Tables get the same treatment (tableTab / tableEnter, further down), and win over the list keys on a
// table line. The editor applies the result through ONE path (features/inline-edit.ts applyTextEdit), which writes
// only the changed span via the browser's own insert, so the textarea's ⌘Z keeps working.
import { tableAt, tableRow } from './markdown.js';

export interface TextEdit { text: string; start: number; end: number }

// A list item's lead: indent, marker (`-`/`*`/`+` or `1.`/`1)`), the gap, and an optional task box.
// The same markers renderBodyHTML draws as a list, plus `1)` (paste-list.ts reads that one too).
const ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;
interface Item { indent: string; marker: string; gap: string; task: string; lead: number }
function itemOf(line: string): Item | null {
  const m = line.match(ITEM);
  return m ? { indent: m[1], marker: m[2], gap: m[3], task: m[4] ?? '', lead: m[0].length } : null;
}
function lineAt(text: string, pos: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return { from, to: nl < 0 ? text.length : nl };
}
const splice = (text: string, from: number, to: number, insert: string): string =>
  text.slice(0, from) + insert + text.slice(to);

// Enter inside a list item starts the NEXT item: same indent, the next number for an ordered list, a
// fresh `[ ] ` for a task (ticked or not — the new one isn't done yet). Enter on an item with nothing
// after its marker ENDS the list instead: the empty marker goes away, which is what Obsidian, Bear and
// GitHub do. Only for a caret (a selection's Enter replaces it, natively) placed past the marker.
export function listEnter(text: string, start: number, end: number): TextEdit | null {
  if (start !== end) return null;
  const { from, to } = lineAt(text, start);
  const it = itemOf(text.slice(from, to));
  if (!it || start < from + it.lead) return null;
  if (!text.slice(from + it.lead, to).trim()) {
    return { text: splice(text, from, to, ''), start: from, end: from };
  }
  const num = it.marker.match(/^(\d+)([.)])$/);
  const marker = num ? `${+num[1] + 1}${num[2]}` : it.marker;
  const ins = '\n' + it.indent + marker + it.gap + (it.task ? '[ ] ' : '');
  return { text: splice(text, start, start, ins), start: start + ins.length, end: start + ins.length };
}

// Tab nests the line(s) the selection touches one level deeper, ⇧Tab lifts them one level out. A
// level is measured, not fixed: one step IN is the width of the item above's marker (`- ` is 2,
// `1. ` is 3), which puts the nested marker under that item's text — the column CommonMark (and so
// Obsidian) needs to read it as nested. One step OUT returns to the indent of the item it's nested
// under. Lines that aren't list items move by the same amount, so a selected block keeps its shape.
// Always an edit (never null): in a note editor Tab must not move focus off the card mid-sentence.
export function indentLines(text: string, start: number, end: number, out: boolean): TextEdit {
  const first = lineAt(text, start).from;
  // a selection ending at the very start of a line doesn't touch that line
  const last = lineAt(text, end > start && text[end - 1] === '\n' ? end - 1 : end).to;
  const lines = text.slice(first, last).split('\n');
  const width = (s: string) => s.replace(/\t/g, '  ').length;
  const lead0 = width(lines[0].match(/^[ \t]*/)![0]);
  // the list items above the first selected line, nearest first
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
    if (!out) nl = l.trim() || lines.length === 1 ? ' '.repeat(step) + l : l;   // blank lines stay blank
    else nl = ' '.repeat(Math.max(0, width(lead) - step)) + l.slice(lead.length);
    if (i === 0) delta0 = nl.length - l.length;
    deltaAll += nl.length - l.length;
    return nl;
  });
  const t = splice(text, first, last, next.join('\n'));
  // The caret rides with its text; a selection grows/shrinks with the lines, its start clamped to the
  // first line's start so an outdent can't pull it onto the line above.
  const s = Math.max(first, start + delta0);
  return { text: t, start: s, end: start === end ? s : Math.max(s, end + deltaAll) };
}

// ⌘B/⌘I/⌘⇧X: wrap the selection in `**`/`*`/`~~`, or UNWRAP it if it already is — whether the
// markers sit just outside the selection or are part of it. A run of the marker's character is read
// whole, so ⌘I inside `**bold**` makes it `***bold***` rather than eating one of bold's stars (only a run
// of exactly the marker, or 3 = bold+italic, holds this marker). Whitespace the selection caught at its
// ends stays outside, since `** bold**` isn't bold. A caret gets an empty pair with the caret inside.
export function toggleWrap(text: string, start: number, end: number, mark: string): TextEdit {
  const ch = mark[0];
  const holds = (run: number) => run === mark.length || (ch === '*' && run === 3);
  const runBack = (at: number) => { let n = 0; while (at - n - 1 >= 0 && text[at - n - 1] === ch) n++; return n; };
  const runFwd = (at: number) => { let n = 0; while (text[at + n] === ch) n++; return n; };
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
  if (a >= b) return { text, start, end };
  // markers just OUTSIDE the selection
  if (holds(runBack(a)) && holds(runFwd(b))) {
    const t = splice(splice(text, b, b + L, ''), a - L, a, '');
    return { text: t, start: a - L, end: b - L };
  }
  // markers INSIDE it (the whole `**word**` selected)
  const inner = text.slice(a, b);
  let lead = 0; while (inner[lead] === ch) lead++;
  let trail = 0; while (trail < inner.length - lead && inner[inner.length - 1 - trail] === ch) trail++;
  if (inner.length > 2 * L && holds(lead) && holds(trail) && lead === trail) {
    const t = splice(splice(text, b - L, b, ''), a, a + L, '');
    return { text: t, start: a, end: b - 2 * L };
  }
  const t = splice(text, a, b, mark + inner + mark);
  return { text: t, start: a + L, end: b + L };
}

// ---------- tables ----------
// In a pipe table Tab walks the CELLS (selecting each one's text, so typing replaces it), Tab past the
// last cell adds a row, and Enter adds a row under the caret's — the moves of every spreadsheet and of
// Obsidian's Advanced Tables. Each of them also TIDIES the table it's in: cells padded so the pipes line
// up (worth it now the editor is monospace), the delimiter row rebuilt from its own `:` alignments.
// Only on these keys and only this table, so nothing rewrites a note you didn't touch, and the tidy is
// whitespace a renderer ignores. What counts as a table is the renderer's own test (markdown.ts
// tableAt/tableRow), so the editor never tidies something the card doesn't draw as one.
const PIPE = /(?:^|[^\\])\|/;
interface TableAt {
  from: number; to: number;       // the table's span in the text, first line's start to last line's end
  rows: string[][];               // header, delimiter, body rows — cells unescaped (tableRow)
  cols: number; align: string[]; indent: string;
  row: number; col: number;       // where the caret is
}
function tableAround(text: string, pos: number): TableAt | null {
  const lines = text.split('\n');
  const before = text.slice(0, pos);
  const li = before.split('\n').length - 1;
  let h = -1, cols = 0;
  for (let i = li; i >= 0 && lines[i].trim() && PIPE.test(lines[i]); i--) {
    if ((cols = tableAt(lines, i))) { h = i; break; }
  }
  if (h < 0) return null;
  let end = h + 2;                                    // renderTable's own end rule
  while (end < lines.length && lines[end].trim() && PIPE.test(lines[end])) end++;
  if (li >= end) return null;
  let from = 0;
  for (let k = 0; k < h; k++) from += lines[k].length + 1;
  const tableLines = lines.slice(h, end);
  const align = tableRow(lines[h + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : c.startsWith(':') ? 'l' : '');
  // the caret's cell: unescaped pipes before it on its line, less the optional leading one
  const line = lines[li], at = pos - (before.lastIndexOf('\n') + 1);
  let pipes = 0;
  for (let k = 0; k < at; k++) if (line[k] === '|' && line[k - 1] !== '\\') pipes++;
  const lead = line.trimStart().startsWith('|') ? 1 : 0;
  return { from, to: from + tableLines.join('\n').length, rows: tableLines.map(tableRow), cols, align,
           indent: lines[h].match(/^[ \t]*/)![0], row: li - h, col: Math.min(cols - 1, Math.max(0, pipes - lead)) };
}
// How many monospace columns a string takes: East Asian wide characters and emoji take two, combining
// marks and joiners none — close enough that a table of names or emoji still lines up.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const ZERO = /[\p{M}\u200D\uFE0F]/u;
function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : ZERO.test(ch) ? 0 : 1;
  return w;
}
// Write the table back tidied, and say where cell (r, c)'s text sits in what was written.
function writeTable(t: TableAt, r: number, c: number): { text: string; start: number; end: number } {
  const cells = t.rows.map(row => row.map(x => x.replace(/\|/g, '\\|')));
  const n = Math.max(t.cols, ...cells.map(row => row.length));
  const w = Array.from({ length: n }, (_, k) =>
    Math.max(3, ...cells.map((row, i) => i === 1 ? 0 : cellWidth(row[k] ?? ''))));
  let out = '', start = 0, end = 0;
  cells.forEach((row, i) => {
    if (i) out += '\n';
    if (i === 1) {
      out += t.indent + '| ' + t.align.map((a, k) => {
        const d = w[k];
        return a === 'c' ? ':' + '-'.repeat(d - 2) + ':' : a === 'r' ? '-'.repeat(d - 1) + ':' : a === 'l' ? ':' + '-'.repeat(d - 1) : '-'.repeat(d);
      }).join(' | ') + ' |';
      return;
    }
    out += t.indent + '| ';
    const len = i === 0 ? t.cols : Math.max(t.cols, row.length);
    for (let k = 0; k < len; k++) {
      const x = row[k] ?? '';
      if (k) out += ' | ';
      if (i === r && k === c) { start = out.length; end = start + x.length; }
      out += x + ' '.repeat(w[k] - cellWidth(x));
    }
    out += ' |';
  });
  return { text: out, start, end };
}
function placeTable(text: string, t: TableAt, r: number, c: number): TextEdit {
  const wr = writeTable(t, r, c);
  return { text: text.slice(0, t.from) + wr.text + text.slice(t.to), start: t.from + wr.start, end: t.from + wr.end };
}
const emptyRow = (t: TableAt): string[] => Array(t.cols).fill('');

// Tab / ⇧Tab: the next / previous cell, row by row, stepping over the delimiter row. Tab out of the
// last cell adds a row; ⇧Tab out of the first stays there. Null off a table (Tab then indents).
export function tableTab(text: string, start: number, _end: number, back: boolean): TextEdit | null {
  const t = tableAround(text, start);
  if (!t) return null;
  let r = t.row, c = t.col;
  if (back) {
    if (r === 1) { r = 0; c = t.cols - 1; }
    else if (--c < 0) { r = r === 2 ? 0 : r - 1; c = t.cols - 1; if (r < 0) { r = 0; c = 0; } }
  } else {
    if (r === 1) { r = 2; c = 0; }
    else if (++c >= t.cols) { r = r === 0 ? 2 : r + 1; c = 0; }
    if (r >= t.rows.length) t.rows.push(emptyRow(t));
  }
  return placeTable(text, t, r, c);
}
// Enter: a new row under the caret's (under the delimiter, from the header), caret in the same column.
// Enter on an EMPTY LAST row ends the table — the row goes, and the caret lands on a new line below it,
// as an empty list item ends a list. And Enter at the end of a lone `| a | b |` line STARTS a table:
// it gets its delimiter row and a first empty row, the way you'd begin one by hand.
export function tableEnter(text: string, start: number, end: number): TextEdit | null {
  const t = tableAround(text, start);
  if (!t) return tableStart(text, start, end);
  if (t.row >= 2 && t.row === t.rows.length - 1 && t.rows[t.row].every(x => !x.trim())) {
    t.rows.pop();
    const wr = writeTable(t, 0, 0);
    const at = t.from + wr.text.length + 1;
    return { text: text.slice(0, t.from) + wr.text + '\n' + text.slice(t.to), start: at, end: at };
  }
  const r = Math.max(2, t.row + 1);
  t.rows.splice(r, 0, emptyRow(t));
  return placeTable(text, t, r, t.col);
}
function tableStart(text: string, start: number, end: number): TextEdit | null {
  if (start !== end) return null;
  const lineEnd = text.indexOf('\n', start);
  if (lineEnd >= 0 ? lineEnd !== start : start !== text.length) return null;   // only at the line's end
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(from, start), s = line.trim();
  if (!s.startsWith('|') || !s.endsWith('|') || s.length < 2) return null;
  const head = tableRow(line);
  if (head.length < 2) return null;                   // `| x |` is too likely to be prose
  const next = text.slice(start + 1).split('\n')[0];
  if (lineEnd >= 0 && PIPE.test(next)) return null;   // already followed by table-ish lines
  const t: TableAt = { from, to: start, rows: [head, [], emptyRow({ cols: head.length } as TableAt)],
    cols: head.length, align: head.map(() => ''), indent: line.match(/^[ \t]*/)![0], row: 0, col: 0 };
  return placeTable(text, t, 2, 0);
}
