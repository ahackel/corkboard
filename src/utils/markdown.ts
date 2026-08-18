// ============================================================
// Markdown -> HTML — a small hand-rolled subset (headings, links, emphasis, task
// lists, pipe tables). NOT a full Markdown parser; extend these functions rather than
// reaching for a library (the no-dependency constraint is deliberate). The card body is
// a clipped preview rendered from this.
// ============================================================

// escape text for safe insertion into SVG/HTML markup
const ESC_MAP: Record<string, string> = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

// Inline emphasis on a PLAIN text run (escaped first so user text can't inject markup).
function mdEmphasis(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g,     '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g,  '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}
// Links/wikilinks within a text run; emphasis is applied to the gaps and link labels.
//   ![alt](src)                  → image (vault-relative path, or a remote/data URL)
//   [text](url) / bare https?:// → external link (new tab)
//   [[Note]] or [[Note|alias]]   → wikilink → focuses that node in the map
// NOTE: the image alternative comes first so ![..](..) isn't mis-read as a link with a stray "!".
function mdLinks(text: string): string {
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(https?:\/\/[^\s)]+)/g;
  let out = '', last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))){
    out += mdEmphasis(text.slice(last, m.index));
    if (m[2])      out += imgTag(m[2], m[1]);                                                         // ![alt](src)
    else if (m[4]) out += `<a class="lk" href="${esc(m[4])}" target="_blank" rel="noopener">${mdEmphasis(m[3])}</a>`;
    else if (m[5]) out += `<a class="lk wikilink" data-target="${esc(m[5].trim())}">${esc((m[6]||m[5]).trim())}</a>`;
    else           out += `<a class="lk" href="${esc(m[7])}" target="_blank" rel="noopener">${esc(m[7])}</a>`;
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
//   - Cells go through `mdInline` (code, links, wikilinks, images, emphasis) but NOT
//     through the task-list branch: `data-ti` numbers checkboxes by body order for
//     write-back, and GFM has no table tasks either.
const TABLE_DELIM_CELL = /^:?-+:?$/;
const UNESCAPED_PIPE = /(?:^|[^\\])\|/;
// Split a row into cells on UNESCAPED pipes (`\|` is a literal pipe in a cell). The
// optional outer pipes are stripped from the LINE first, not dropped as empty cells —
// `| a | |` has a genuine empty last cell.
function tableRow(line: string): string[] {
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
function tableAt(lines: string[], i: number): number {
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

// Block-level pass: headings, lists, blockquotes, fenced code, rules, tables, paragraphs.
export function renderBodyHTML(md: string | null | undefined): string {
  const src = (md || '').replace(/\r\n?/g, '\n').trim();
  if (!src) return '';                 // empty body → nothing (no stray blank line under the title)
  const lines = src.split('\n');
  let html = '', i = 0, taskIdx = 0;   // taskIdx: nth checkbox in the body, for write-back on toggle
  const BLOCK = /^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/;
  while (i < lines.length){
    const line = lines[i];
    if (/^```/.test(line)){                                   // fenced code block
      i++; const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;                                                    // skip closing fence
      html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; continue;
    }
    let h: RegExpMatchArray | null;
    if ((h = line.match(/^(#{1,6})\s+(.*)$/))){               // heading
      html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; i++; continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)){ html += '<hr>'; i++; continue; }   // horizontal rule
    const cols = tableAt(lines, i);                            // pipe table (header + delimiter row)
    if (cols){ const t = renderTable(lines, i, cols); html += t.html; i = t.next; continue; }
    if (/^\s*>/.test(line)){                                   // blockquote
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${q.map(mdInline).join('<br>')}</blockquote>`; continue;
    }
    if (/^\s*[-*+]\s+/.test(line)){                            // unordered list (incl. [ ]/[x] tasks)
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      html += '<ul>' + items.map(it => {
        const tm = it.match(/^\[([ xX])\]\s+(.*)$/);
        if (tm) return `<li class="task"><input type="checkbox" class="taskbox" data-ti="${taskIdx++}"`
                     + `${tm[1].toLowerCase()==='x' ? ' checked' : ''}>${mdInline(tm[2])}</li>`;
        return `<li>${mdInline(it)}</li>`;
      }).join('') + '</ul>'; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)){                            // ordered list
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      html += `<ol>${items.map(it => `<li>${mdInline(it)}</li>`).join('')}</ol>`; continue;
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
    while (i < lines.length && !BLOCK.test(lines[i]) && !tableAt(lines, i)) run.push(lines[i++]);
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
