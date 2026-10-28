// ============================================================
// Markdown -> HTML — a small hand-rolled subset (headings, links, emphasis, task
// lists, pipe tables). NOT a full Markdown parser; extend these functions rather than
// reaching for a library (the no-dependency constraint is deliberate). The card body is
// a clipped preview rendered from this.
// ============================================================

import { INLINE_TAG } from './tags.js';

// escape text for safe insertion into SVG/HTML markup
const ESC_MAP: Record<string, string> = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

// A PLAIN text run: its `#tags` (utils/tags.ts — Obsidian's, so a tag here is one there) set apart, and
// emphasis on the text between them. Tags first, so a `#snake_case_tag` isn't read as emphasis.
function mdEmphasis(s: string): string {
  let out = '', last = 0;
  for (const m of s.matchAll(INLINE_TAG)){
    if (/^[\d/]+$/.test(m[2])) continue;   // `#12` is a number, not a tag
    const at = m.index + m[1].length;
    out += mdStyle(s.slice(last, at)) + `<span class="md-tag" data-tag="${esc(m[2])}">#${esc(m[2])}</span>`;
    last = at + 1 + m[2].length;
  }
  return out + mdStyle(s.slice(last));
}
// Inline emphasis (escaped first so user text can't inject markup).
function mdStyle(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g,     '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g,  '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=\s][^=]*?)==/g, '<mark>$1</mark>');            // Obsidian's highlight
}
// Links/wikilinks within a text run; emphasis is applied to the gaps and link labels.
//   ![alt](src)                  → image (vault-relative path, or a remote/data URL)
//   [text](url) / <https://…> / bare https?:// → external link (new tab)
//   [[Note]] or [[Note|alias]]   → wikilink → focuses that node in the map
// NOTE: the image alternative comes first so ![..](..) isn't mis-read as a link with a stray "!".
function mdLinks(text: string): string {
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s)]+)/g;
  let out = '', last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))){
    out += mdEmphasis(text.slice(last, m.index));
    if (m[2])      out += imgTag(m[2], m[1]);                                                         // ![alt](src)
    else if (m[4]) out += `<a class="lk" href="${esc(m[4])}" target="_blank" rel="noopener">${mdEmphasis(m[3])}</a>`;
    else if (m[5]) out += `<a class="lk wikilink" data-target="${esc(m[5].trim())}">${esc((m[6]||m[5]).trim())}</a>`;
    else { const u = m[7] ?? m[8];                                                                    // <url> or a bare one
           out += `<a class="lk" href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`; }
    last = re.lastIndex;
  }
  out += mdEmphasis(text.slice(last));
  return out;
}
// ---------- a note that is nothing but a picture ----------
// There is no image KIND: a card whose whole note is one `![alt](src)` — and which carries no title
// to draw — IS that image, and renders as one (no padding, both axes authored, the picture flush to
// its corners; see isImageCard in core/state.ts and isImageBox in main.ts). The test is deliberately
// the WHOLE body, so the rule is one a user can see in the text: type a word or a heading and the
// card is an ordinary card again, with its padding and its measured height back.
// Returns the alt + src so the callers that name a file after the picture don't re-parse it.
export interface SoleImage { alt: string; src: string }
export function soleImage(body: string | null | undefined): SoleImage | null {
  const m = (body ?? '').trim().match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
  return m ? { alt: m[1].trim(), src: m[2] } : null;
}
// Every `![alt](src)` in a note, in reading order — the one spelling of "the pictures in a body".
export function* bodyImages(body: string | null | undefined): Generator<SoleImage> {
  for (const m of (body ?? '').matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) yield { alt: m[1].trim(), src: m[2] };
}
export const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A note with one picture's reference taken out (its line too, if that was all the line held).
export function stripImageRef(body: string, src: string): string {
  const re = new RegExp(`[ \\t]*!\\[[^\\]]*\\]\\(\\s*${escRe(src)}\\s*\\)[ \\t]*\\n?`);
  return body.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- the tasks in a note ----------
// The lines renderList draws as checkboxes, in body order: a BULLET, `[ ]`/`[x]`, then text. A numbered
// `1. [ ]` isn't one, and fenced code is skipped, so a markdown sample in a code block isn't counted.
const TASK_LINE = /^(\s*[-*+]\s+\[)([ xX])\]\s+\S/;

function* taskLines(lines: string[]): Generator<{ i: number; mark: string; markAt: number }> {
  let fence = '';
  for (const [i, line] of lines.entries()) {
    const f = line.match(/^(```|~~~)/);
    if (f) {
      fence = fence ? (line.startsWith(fence) ? '' : fence) : f[1];
      continue;
    }
    const m = fence ? null : line.match(TASK_LINE);
    if (m) {
      yield { i, mark: m[2], markAt: m[1].length };
    }
  }
}

export function taskProgress(md: string | null | undefined): { done: number; total: number } {
  let done = 0, total = 0;
  for (const t of taskLines((md ?? '').split('\n'))) {
    total++;
    if (t.mark !== ' ') {
      done++;
    }
  }
  return { done, total };
}

// The note with its idx-th task ticked or unticked — idx as the card numbers its checkboxes (`data-ti`).
export function toggleTaskAt(md: string, idx: number): string {
  const lines = md.split('\n');
  let n = 0;
  for (const t of taskLines(lines)) {
    if (n++ === idx) {
      const line = lines[t.i];
      lines[t.i] = line.slice(0, t.markAt) + (t.mark === ' ' ? 'x' : ' ') + line.slice(t.markAt + 1);
      break;
    }
  }
  return lines.join('\n');
}

// ---------- writing a link, rather than rendering one ----------
// Pasting a URL over selected text LINKS that text, the way every note app does it — the one thing
// markdown's `[label](url)` costs that a rich editor's ⌘K doesn't. The rule lives here beside mdLinks
// because it's the same three forms read backwards, and drifting from them would link text the
// renderer then wouldn't show as a link. Every note editor binds it (features/inline-edit.ts
// pasteUrlLink); this half is pure so the editors share one answer.
// A URL is a single whitespace-free token carrying a scheme — `mailto:` included, since it's the one
// common form with no `//`. Deliberately strict: `docs/notes.md` pasted over a word is text a user
// meant to paste, not a link they meant to make.
const URL_ONLY = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)[^\s<>]+$/i;
// The three forms mdLinks renders, matched to be REWRITTEN — the url group is `*` rather than `+`
// here so a half-written `[label]()` is still recognised as the link it's going to be.
const LINK_SCAN = /!\[([^\]]*)\]\(([^)\s]*)\)|\[([^\]]+)\]\(([^)\s]*)\)|(https?:\/\/[^\s)]+)/g;
export interface LinkPaste { text: string; start: number; end: number }
// The text after pasting `url` over [start,end), plus where the selection lands (on the LABEL, so
// what you selected is still what you see) — or null to let the paste happen natively.
export function linkPaste(text: string, start: number, end: number, url: string): LinkPaste | null {
  const u = url.trim();
  if (start === end || !URL_ONLY.test(u)) return null;
  const sel = text.slice(start, end);
  if (sel.includes('\n')) return null;               // a label is one line; wrapping two would break it
  // An existing link the selection touches gets its URL REPLACED, label intact — whether the
  // selection is the label, the whole `[…](…)`, or a stretch of text containing one. That last case
  // could equally mean "link all of this", but a link inside a label is invalid markdown, and
  // rewriting the one that's there is the reading that can't produce a broken note.
  LINK_SCAN.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = LINK_SCAN.exec(text)); ){
    const ms = m.index, me = ms + m[0].length;
    if (me <= start || ms >= end) continue;          // no overlap with the selection
    if (m[1] !== undefined) return null;             // an image: its src isn't a link to update
    if (m[5]) return { text: text.slice(0, ms) + u + text.slice(me), start: ms, end: ms + u.length };
    const label = m[3];
    return { text: text.slice(0, ms) + `[${label}](${u})` + text.slice(me), start: ms + 1, end: ms + 1 + label.length };
  }
  // Otherwise wrap what was selected, leaving any whitespace it caught outside the brackets.
  const lead = sel.length - sel.trimStart().length;
  const label = sel.trim();
  if (!label) return null;
  const at = start + lead;
  return { text: text.slice(0, at) + `[${label}](${u})` + text.slice(at + label.length),
           start: at + 1, end: at + 1 + label.length };
}

// An <img> for inline markdown. The real src is resolved after insertion (hydrateImages): vault
// paths are read from the store as blob URLs, remote/data URLs pass through — so rendering stays
// synchronous while disk reads happen lazily.
// data-img-src is consumed (removed) by hydrateImages; data-path stays on the element so the
// context menu can map a rendered <img> back to its markdown reference / vault file.
// Wrapped in .img-wrap so the magnifier button (shown only on a selected card, see styles.css)
// can position over the image; the button opens the full-screen viewer (main.ts nodeEl click).
function imgTag(src: string, alt: string): string {
  const s = esc(src.trim());
  return `<span class="img-wrap"><img class="md-img" data-img-src="${s}" data-path="${s}" alt="${esc(alt || '')}">`
    + `<button type="button" class="img-zoom" tabindex="-1" aria-label="View image">`
    + `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
    + `</button></span>`;
}
// Full inline pass: protect `code` spans first (no formatting inside), then links + emphasis.
function mdInline(text: string): string {
  let out = '', last = 0;
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))){
    out += mdLinks(text.slice(last, m.index));
    out += `<code>${esc(m[1])}</code>`;
    last = re.lastIndex;
  }
  out += mdLinks(text.slice(last));
  return out;
}
// ---- GFM pipe tables -------------------------------------------------------------
// A table is a header row, a DELIMITER row (`|:--|--:|`) with the SAME number of cells,
// then body rows — the strict GFM rule, so a note renders the same here, in Obsidian and
// on GitHub, and prose that merely contains a `|` stays prose. Two consequences:
//   - Spotting one takes TWO lines, so it can't join the one-line `BLOCK` regex; `tableAt`
//     is asked separately by the block loop AND by the paragraph gatherer, since a table
//     interrupts a text run.
//   - utils/md-edit.ts (the editor's table keys) reads tables through the same `tableAt`/`tableRow`,
//     so a table the editor tidies is exactly one the card draws.
//   - Cells go through `mdInline` (code, links, wikilinks, images, emphasis) but NOT
//     through the task-list branch: `data-ti` numbers checkboxes by body order for
//     write-back, and GFM has no table tasks either.
const TABLE_DELIM_CELL = /^:?-+:?$/;
const UNESCAPED_PIPE = /(?:^|[^\\])\|/;
// Split a row into cells on UNESCAPED pipes (`\|` is a literal pipe in a cell). The
// optional outer pipes are stripped from the LINE first, not dropped as empty cells —
// `| a | |` has a genuine empty last cell.
export function tableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (UNESCAPED_PIPE.test(s) && s.endsWith('|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++){
    if (s[i] === '\\' && s[i+1] === '|'){ cur += '|'; i++; continue; }
    if (s[i] === '|'){ cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
// Column count if a table starts at line i, else 0 (so it's falsy at the call sites).
export function tableAt(lines: string[], i: number): number {
  const head = lines[i], delim = lines[i+1];
  if (head == null || delim == null) return 0;
  if (!UNESCAPED_PIPE.test(head) || !UNESCAPED_PIPE.test(delim)) return 0;
  const dc = tableRow(delim);
  if (!dc.every(c => TABLE_DELIM_CELL.test(c))) return 0;
  return tableRow(head).length === dc.length ? dc.length : 0;
}
// text-align from a delimiter cell's colons; left is the default, so it needs no style.
function tableAlign(cell: string): string {
  const l = cell.startsWith(':'), r = cell.endsWith(':');
  return l && r ? 'center' : r ? 'right' : '';
}
// Consume the table at `start`; returns its HTML and the line after it. Ragged rows are
// padded/truncated to the header's column count (GFM does the same).
function renderTable(lines: string[], start: number, cols: number): { html: string; next: number } {
  const align = tableRow(lines[start+1]).map(tableAlign);
  const row = (cells: string[], tag: 'th' | 'td') => {
    let out = '<tr>';
    for (let c = 0; c < cols; c++){
      const a = align[c] ? ` style="text-align:${align[c]}"` : '';
      out += `<${tag}${a}>${mdInline(cells[c] ?? '')}</${tag}>`;
    }
    return out + '</tr>';
  };
  let i = start + 2, body = '';
  while (i < lines.length && lines[i].trim() && UNESCAPED_PIPE.test(lines[i])) body += row(tableRow(lines[i++]), 'td');
  return { html: `<table><thead>${row(tableRow(lines[start]), 'th')}</thead><tbody>${body}</tbody></table>`, next: i };
}

// ---- lists, nested by indentation -------------------------------------------------
// A run of item lines is ONE list block whatever its markers, nested by each line's indent: deeper
// than the open level opens a list INSIDE the item above (where CommonMark and Obsidian put it), less
// closes back out to the level it matches. Indent is compared, never counted in fixed steps, so `  -`
// and `    -` both nest under `-`, and a `1. ` item's three-space children do too. A change of marker
// kind at the same level starts a sibling list (`<ul>` → `<ol>`). Only bullets make TASKS — `data-ti`
// numbers checkboxes in body order for write-back (main.ts toggleTask), which counts `- [ ]` lines only.
// A task's text is wrapped in a span because the row is a flex box (styles.css li.task): bare, the text
// would wrap under the checkbox, and a nested list would sit BESIDE it instead of below.
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;
function renderList(lines: string[], taskIdx: number): { html: string; taskIdx: number } {
  let html = '';
  const open: Array<{ indent: number; tag: 'ul' | 'ol' }> = [];
  // an ordered list starts at its FIRST item's number (`3.` → 3), as in CommonMark; later numbers are ignored
  const opener = (tag: 'ul' | 'ol', marker: string): string =>
    tag === 'ol' && parseInt(marker, 10) !== 1 ? `<ol start="${parseInt(marker, 10)}">` : `<${tag}>`;
  const li = (body: string, tag: 'ul' | 'ol'): string => {
    const tm = tag === 'ul' && body.match(/^\[([ xX])\]\s+(\S.*)$/);
    if (tm) return `<li class="task"><input type="checkbox" class="taskbox" data-ti="${taskIdx++}"`
                 + `${tm[1].toLowerCase()==='x' ? ' checked' : ''}><span class="task-text">${mdInline(tm[2])}</span>`;
    return `<li>${mdInline(body)}`;
  };
  for (const line of lines){
    const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)!;
    const indent = m[1].replace(/\t/g, '  ').length;
    const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
    while (open.length > 1 && indent < open[open.length - 1].indent) html += `</li></${open.pop()!.tag}>`;
    const top = open[open.length - 1];
    if (!top || indent > top.indent){                         // a new level, inside the open item
      html += opener(tag, m[2]); open.push({ indent, tag });
    } else {
      html += '</li>';
      if (tag !== top.tag){ html += `</${top.tag}>` + opener(tag, m[2]); top.tag = tag; }
    }
    html += li(m[3], tag);
  }
  while (open.length) html += `</li></${open.pop()!.tag}>`;
  return { html, taskIdx };
}

// A thematic break: three or more `-`, `*` or `_`, spaces allowed between. It ENDS a text run too, so a
// `---` straight under a line of text is a rule — CommonMark would make that line a "setext" heading,
// but nobody writes headings that way in a note, and everybody draws a line that way.
const HR = /^\s*(?:[-*_]\s*){3,}$/;

// Block-level pass: headings, lists, blockquotes, fenced code, rules, tables, paragraphs.
export function renderBodyHTML(md: string | null | undefined): string {
  const src = (md || '').replace(/\r\n?/g, '\n').trim();
  if (!src) return '';                 // empty body → nothing (no stray blank line under the title)
  const lines = src.split('\n');
  let html = '', i = 0, taskIdx = 0;   // taskIdx: nth checkbox in the body, for write-back on toggle
  const BLOCK = /^(#{1,6}\s|```|~~~|\s*>|\s*[-*+]\s|\s*\d+\.\s)/;
  while (i < lines.length){
    const line = lines[i];
    const fence = line.match(/^(```|~~~)/);
    if (fence){                                               // fenced code block, ``` or ~~~
      i++; const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith(fence[1])) code.push(lines[i++]);
      i++;                                                    // skip closing fence
      html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; continue;
    }
    let h: RegExpMatchArray | null;
    if ((h = line.match(/^(#{1,6})\s+(.*)$/))){               // heading
      html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; i++; continue;
    }
    if (HR.test(line)){ html += '<hr>'; i++; continue; }      // horizontal rule
    const cols = tableAt(lines, i);                            // pipe table (header + delimiter row)
    if (cols){ const t = renderTable(lines, i, cols); html += t.html; i = t.next; continue; }
    if (/^\s*>/.test(line)){                                   // blockquote
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${q.map(mdInline).join('<br>')}</blockquote>`; continue;
    }
    if (LIST_ITEM.test(line)){                                 // list: bullets, numbers, [ ]/[x] tasks, nested
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]) && !HR.test(lines[i])) items.push(lines[i++]);
      const r = renderList(items, taskIdx);
      html += r.html; taskIdx = r.taskIdx; continue;
    }
    // Text run: gather until the next block, then split it into PARAGRAPHS on blank lines — one <p>
    // per group of non-blank lines, and A RUN OF BLANK LINES IS ONE BREAK however many lines it is.
    // The gap between two paragraphs is then CSS's to give (`.node .body p`'s bottom margin, half a
    // line), not the file's: how many times someone hit Return is not a layout instruction, and a
    // note that grew four blank lines while it was being edited shouldn't render four empty lines on
    // the card. Same reading Obsidian's reading view gives it. A run that is ONLY blank lines — the
    // gap between two blocks — emits nothing at all, since both blocks carry their own margins.
    // Within a paragraph a single newline still breaks the line (<br>), which is the one place the
    // author's Return is taken literally, and the behaviour every card on every existing map has.
    const run: string[] = [];
    while (i < lines.length && !BLOCK.test(lines[i]) && !HR.test(lines[i]) && !tableAt(lines, i)) run.push(lines[i++]);
    let para: string[] = [];
    const flushPara = (): void => {
      if (para.length) html += `<p>${para.map(mdInline).join('<br>')}</p>`;
      para = [];
    };
    for (const l of run) { if (l.trim()) para.push(l); else flushPara(); }
    flushPara();
  }
  return html;
}
