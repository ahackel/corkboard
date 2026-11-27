// Pipe tables in the card's textarea: the same pure text → text shape as utils/md-edit.ts.
import { tableAt, tableRow } from './markdown.js';
import { lineAt, type TextEdit } from './text-edit.js';


// Tab/Enter walk and add cells like a spreadsheet, and TIDY only the table they're in. A table is
// whatever the renderer's tableAt says, so the editor never tidies something not drawn as one.
const PIPE = /(?:^|[^\\])\|/;
interface TableAt {
  from: number; to: number;       // first line's start to last line's end
  rows: string[][];               // header, delimiter, body rows, cells unescaped
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
  if (h < 0) {
    return null;
  }
  let end = h + 2;                                    // renderTable's own end rule
  while (end < lines.length && lines[end].trim() && PIPE.test(lines[end])) {
    end++;
  }
  if (li >= end) {
    return null;
  }
  let from = 0;
  for (let k = 0; k < h; k++) {
    from += lines[k].length + 1;
  }
  const tableLines = lines.slice(h, end);
  const align = tableRow(lines[h + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : c.startsWith(':') ? 'l' : '');

  // Unescaped pipes before the caret on its line, less the optional leading one.
  const line = lines[li], at = pos - (before.lastIndexOf('\n') + 1);
  let pipes = 0;
  for (let k = 0; k < at; k++) {
    if (line[k] === '|' && line[k - 1] !== '\\') {
      pipes++;
    }
  }
  const lead = line.trimStart().startsWith('|') ? 1 : 0;
  return { from, to: from + tableLines.join('\n').length, rows: tableLines.map(tableRow), cols, align,
           indent: lines[h].match(/^[ \t]*/)![0], row: li - h, col: Math.min(cols - 1, Math.max(0, pipes - lead)) };
}

// Wide characters and emoji take two columns, combining marks none: close enough for names and emoji.
const WIDE = /\p{Emoji_Presentation}|[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

// eslint-disable-next-line no-misleading-character-class -- each is matched ONE BY ONE on purpose
const ZERO_WIDTH = /[\p{M}\u200D\uFE0F]/u;

function cellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += WIDE.test(ch) ? 2 : ZERO_WIDTH.test(ch) ? 0 : 1;
  }
  return w;
}

// Wider than this a table is written COMPACT: padding sentences to the widest cell makes a wall of spaces.
const TIDY_WIDTH = 80;

// Also returns where cell (r, c)'s text sits in what was written.
function writeTable(t: TableAt, r: number, c: number): { text: string; start: number; end: number } {
  const cells = t.rows.map(row => row.map(x => x.replace(/\|/g, '\\|')));
  const n = Math.max(t.cols, ...cells.map(row => row.length));
  let w = Array.from({ length: n }, (_, k) =>
    Math.max(3, ...cells.map((row, i) => i === 1 ? 0 : cellWidth(row[k] ?? ''))));
  const compact = w.reduce((a, b) => a + b, 0) + 3 * n + 1 > TIDY_WIDTH;
  if (compact) {
    w = w.map(() => 3);   // the delimiter row's dashes; the cells themselves get no padding
  }
  let out = '', start = 0, end = 0;
  cells.forEach((row, i) => {
    if (i) {
      out += '\n';
    }
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
      if (k) {
        out += ' | ';
      }
      if (i === r && k === c) { start = out.length; end = start + x.length; }
      out += x + (compact ? '' : ' '.repeat(w[k] - cellWidth(x)));
    }
    out += ' |';
  });
  return { text: out, start, end };
}

function placeTable(text: string, t: TableAt, r: number, c: number): TextEdit {
  const wr = writeTable(t, r, c);
  const out = text.slice(0, t.from) + wr.text + text.slice(t.to);
  const start = t.from + wr.start, end = t.from + wr.end;
  return /\s/.test(out.slice(start, end)) ? { text: out, start: end, end } : { text: out, start, end };
}
const emptyRow = (t: TableAt): string[] => Array(t.cols).fill('');

// Tab out of the last cell adds a row. Null off a table (Tab then indents).
export function tableTab(text: string, start: number, _end: number, back: boolean): TextEdit | null {
  const t = tableAround(text, start);
  if (!t) {
    return null;
  }
  let r = t.row, c = t.col;
  if (back) {
    if (r === 1) { r = 0; c = t.cols - 1; }
    else if (--c < 0) { r = r === 2 ? 0 : r - 1; c = t.cols - 1; if (r < 0) { r = 0; c = 0; } }
  } else {
    if (r === 1) { r = 2; c = 0; }
    else if (++c >= t.cols) { r = r === 0 ? 2 : r + 1; c = 0; }
    if (r >= t.rows.length) {
      t.rows.push(emptyRow(t));
    }
  }
  return placeTable(text, t, r, c);
}

// Enter on an EMPTY LAST row ends the table; at the end of a lone `| a | b |` line it STARTS one.
export function tableEnter(text: string, start: number, end: number): TextEdit | null {
  const t = tableAround(text, start);
  if (!t) {
    return tableStart(text, start, end);
  }
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
  if (start !== end) {
    return null;
  }
  const lineEnd = text.indexOf('\n', start);
  if (lineEnd >= 0 ? lineEnd !== start : start !== text.length) {
    return null;   // only at the line's end
  }
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(from, start), s = line.trim();
  if (!s.startsWith('|') || !s.endsWith('|') || s.length < 2) {
    return null;
  }
  const head = tableRow(line);
  if (head.length < 2) {
    return null;                   // `| x |` is too likely to be prose
  }
  const next = text.slice(start + 1).split('\n')[0];
  if (lineEnd >= 0 && PIPE.test(next)) {
    return null;   // already followed by table-ish lines
  }
  const t: TableAt = { from, to: start, rows: [head, [], emptyRow({ cols: head.length } as TableAt)],
    cols: head.length, align: head.map(() => ''), indent: line.match(/^[ \t]*/)![0], row: 0, col: 0 };
  return placeTable(text, t, 2, 0);
}

// Only BODY rows move: above the delimiter a row would become the header, below the end it leaves the table.
export function tableRowsMayMove(text: string, start: number, end: number, up: boolean): boolean {
  const ta = tableAround(text, start), tb = tableAround(text, end);
  if (!ta && !tb) {
    return true;
  }
  if (!ta || !tb || ta.from !== tb.from || ta.row < 2) {
    return false;
  }
  return up ? ta.row > 2 : tb.row < ta.rows.length - 1;
}

// Tab-separated rows from a spreadsheet (quoted cells may hold breaks/tabs). Two or more rows of the same
// two-plus columns become a table; anything else pastes as text.
function parseTsv(s: string): string[][] | null {
  if (!s.includes('\t')) {
    return null;
  }
  s = s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false, fresh = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          q = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && fresh) { q = true; fresh = false; }
    else if (ch === '\t') { row.push(cell); cell = ''; fresh = true; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; fresh = true; }
    else { cell += ch; fresh = false; }
  }
  row.push(cell); rows.push(row);
  const cols = rows[0].length;
  if (rows.length < 2 || cols < 2 || rows.some(x => x.length !== cols)) {
    return null;
  }
  return rows.map(x => x.map(c => c.replace(/\s*\n\s*/g, ' ').trim()));
}

export function pasteTable(text: string, start: number, end: number, clip: string): TextEdit | null {
  const rows = parseTsv(clip);
  if (!rows || tableAround(text, start)) {
    return null;
  }
  const cols = rows[0].length;
  const t: TableAt = { from: 0, to: 0, rows: [rows[0], [], ...rows.slice(1)], cols,
    align: rows[0].map(() => ''), indent: '', row: 0, col: 0 };
  const table = writeTable(t, 0, 0).text;
  const before = text.slice(0, start), after = text.slice(end);
  const pre = before && !before.endsWith('\n') ? '\n' : '';
  const post = after && !after.startsWith('\n') ? '\n' : '';
  const at = start + pre.length + table.length;
  return { text: before + pre + table + post + after, start: at, end: at };
}

// Set apart by blank lines so Obsidian reads it as a table too; the first header is selected.
export function insertTable(text: string, _start: number, end: number): TextEdit {
  const { from, to } = lineAt(text, end);
  const blank = !text.slice(from, to).trim();
  const t: TableAt = { from: 0, to: 0, rows: [['Column 1', 'Column 2'], [], ['', '']], cols: 2, align: ['', ''], indent: '', row: 0, col: 0 };
  const table = writeTable(t, 0, 0).text;
  const head = blank ? text.slice(0, from) : text.slice(0, to) + '\n\n';
  const tail = text.slice(to);
  const gap = tail.startsWith('\n') && tail.slice(1).split('\n')[0].trim() ? '\n' : '';
  const at = head.length + 2;
  return { text: head + table + gap + tail, start: at, end: at + 'Column 1'.length };
}

// The Edit Table menu. Null where an op can't apply, which also greys it out in the menu.
export type TableOp = 'sortAsc' | 'sortDesc' | 'rowAbove' | 'rowBelow' | 'colBefore' | 'colAfter' |
  'alignLeft' | 'alignCenter' | 'alignRight' | 'deleteCol' | 'deleteRow' | 'colLeft' | 'colRight' |
  'rowUp' | 'rowDown' | 'reformat' | 'transpose';

export function tableEdit(text: string, start: number, op: TableOp): TextEdit | null {
  const t = tableAround(text, start);
  if (!t) {
    return null;
  }
  const r = t.row === 1 ? 0 : t.row, c = t.col;
  const last = t.rows.length - 1;
  const at = (rr: number, cc: number): TextEdit => placeTable(text, t, rr === 1 ? 0 : rr, cc);
  for (const [i, row] of t.rows.entries()) {
    while (i !== 1 && row.length < t.cols) {
      row.push('');
    }
  }
  const cells = (f: (row: string[]) => void, alignToo: (a: string[]) => void): void => {
    t.rows.forEach((row, i) => i !== 1 && f(row));
    alignToo(t.align);
  };
  const swap = <T>(xs: T[], i: number, j: number): void => { [xs[i], xs[j]] = [xs[j], xs[i]]; };
  switch (op) {
    case 'sortAsc':
    case 'sortDesc': {
      if (last < 3) {
        return null;                           // fewer than two body rows: nothing to sort
      }
      const dir = op === 'sortAsc' ? 1 : -1;
      const body = t.rows.slice(2).sort((x, y) => dir * x[c].localeCompare(y[c], undefined, { numeric: true, sensitivity: 'base' }));
      t.rows.splice(2, body.length, ...body);
      return at(0, c);
    }
    case 'rowAbove':
      if (r < 2) {
        return null;                           // nothing goes above the header
      }
      t.rows.splice(r, 0, emptyRow(t));
      return at(r, c);
    case 'rowBelow':
      t.rows.splice(Math.max(2, r + 1), 0, emptyRow(t));
      return at(Math.max(2, r + 1), c);
    case 'colBefore':
    case 'colAfter': {
      const k = op === 'colBefore' ? c : c + 1;
      cells(row => row.splice(k, 0, ''), a => a.splice(k, 0, ''));
      t.cols++;
      return at(r, k);
    }
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight':
      t.align[c] = op === 'alignLeft' ? 'l' : op === 'alignCenter' ? 'c' : 'r';
      return at(r, c);
    case 'deleteCol':
      if (t.cols < 2) {
        return null;
      }
      cells(row => row.splice(c, 1), a => a.splice(c, 1));
      t.cols--;
      return at(r, Math.min(c, t.cols - 1));
    case 'deleteRow':
      if (r < 2) {
        return null;
      }
      t.rows.splice(r, 1);
      return at(Math.min(r, t.rows.length - 1), c);
    case 'colLeft':
    case 'colRight': {
      const k = op === 'colLeft' ? c - 1 : c + 1;
      if (k < 0 || k >= t.cols) {
        return null;
      }
      cells(row => swap(row, c, k), a => swap(a, c, k));
      return at(r, k);
    }
    case 'rowUp':
    case 'rowDown': {
      const k = op === 'rowUp' ? r - 1 : r + 1;
      if (r < 2 || k < 2 || k > last) {
        return null;                           // only body rows move, and only among themselves
      }
      swap(t.rows, r, k);
      return at(k, c);
    }
    case 'reformat':
      return at(r, c);
    case 'transpose': {
      const grid = [t.rows[0], ...t.rows.slice(2)];
      const flipped = Array.from({ length: t.cols }, (_, k) => grid.map(row => row[k] ?? ''));
      t.rows = [flipped[0], [], ...flipped.slice(1)];
      t.cols = grid.length;
      t.align = Array<string>(grid.length).fill('');
      return at(0, 0);
    }
  }
}
