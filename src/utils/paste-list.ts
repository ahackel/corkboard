// Is pasted text a LIST — one thought per line — rather than one note? Then it becomes one card per
// item (features/attachments.ts), which is how a pile of ideas gets onto the board in one go.
// Pure, so tests/paste-list.test.ts pins the rule down.
//
// Two shapes count:
//  - a Markdown list: every top-level line is an item (`-`, `*`, `+`, `•`, `1.`, `1)`, with or
//    without a `[ ]` box). Blank lines between items are fine; an indented line belongs to the item
//    above and rides along as its body, dedented — so a nested list stays inside its card.
//  - bare lines: two or more short lines, no blank line between them, no Markdown structure.
// Anything else — a heading, prose with blank-line paragraphs, a line of lead-in text before a list —
// is a NOTE, and stays one card. Returns the items' texts, or null for "not a list".
const ITEM = /^([-*+•]|\d+[.)])\s+(\[[ xX]\]\s+)?/;
const MAX_LINE = 200;   // a bare line longer than this is a paragraph, not an item

export function splitPastedList(text: string): string[] | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length < 2) return null;
  const indent = (l: string): number => l.length - l.trimStart().length;
  const base = indent(lines[0]);
  if (ITEM.test(lines[0].trimStart())) {
    const items: string[][] = [];
    for (const l of lines) {
      if (!l.trim()) { items[items.length - 1].push(''); continue; }
      if (indent(l) <= base) {
        const t = l.trimStart();
        if (!ITEM.test(t)) return null;      // a top-level line that is not an item: it's a note
        items.push([t.replace(ITEM, '')]);
      } else items[items.length - 1].push(l);
    }
    if (items.length < 2) return null;
    return items.map(([head, ...rest]) => {
      while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
      const cut = Math.min(...rest.filter(l => l.trim()).map(indent));
      return [head.trim(), ...rest.map(l => l.slice(cut))].join('\n');
    }).filter(t => t.trim());
  }
  if (lines.some(l => !l.trim() || l.trim().length > MAX_LINE || /^#{1,6}\s/.test(l.trim()))) return null;
  if (lines.some(l => ITEM.test(l.trimStart()) || indent(l) > base)) return null;   // structured: a note
  return lines.map(l => l.trim());
}
