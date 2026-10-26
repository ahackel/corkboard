// ---------- writing markdown in the card's textarea ----------
// The small set of things a note editor does FOR you, as pure text → text functions so tests/ pins
// them without a browser: a list that continues itself on Enter, Tab/⇧Tab nesting list items, and
// ⌘B/⌘I/⌘⇧X wrapping the selection. Each returns the WHOLE new text plus where the selection lands
// (the same shape as utils/markdown.ts linkPaste), or null to let the key do what it natively does.
// The editor applies the result through ONE path (features/inline-edit.ts applyTextEdit), which writes
// only the changed span via the browser's own insert, so the textarea's ⌘Z keeps working.
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
