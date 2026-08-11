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
    // text run: gather until the next block. Every blank line is KEPT and rendered as an empty
    // line (like Obsidian) — including blanks right before/after a list or other block. A run
    // that's only blank lines (a gap between two blocks) becomes that many empty lines.
    const para: string[] = [];
    while (i < lines.length && !BLOCK.test(lines[i]) && !tableAt(lines, i)) para.push(lines[i++]);
    if (para.some(l => l.trim())) html += `<p>${para.map(mdInline).join('<br>')}</p>`;
    else html += '<br>'.repeat(para.length);
  }
  return html;
}
