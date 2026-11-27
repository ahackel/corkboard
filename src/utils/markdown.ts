// Markdown -> HTML: a small hand-rolled subset. Extend it rather than reaching for a library.
import { INLINE_TAG } from './tags.js';
import { IMAGE_FILE_RE } from './image-types.js';

const ESC_MAP: Record<string, string> = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

// XMLSerializer passes through characters XML forbids, and one makes a whole SVG undecodable.
export function xmlSafe(s: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// Tags go first, so a `#snake_case_tag` isn't read as emphasis.
function mdEmphasis(s: string): string {
  let out = '', last = 0;
  for (const m of s.matchAll(INLINE_TAG)){
    if (/^[\d/]+$/.test(m[2])) {
      continue;   // `#12` is a number, not a tag
    }
    const at = m.index + m[1].length;
    out += mdStyle(s.slice(last, at)) + `<span class="md-tag" data-tag="${esc(m[2])}">#${esc(m[2])}</span>`;
    last = at + 1 + m[2].length;
  }
  return out + mdStyle(s.slice(last));
}

// Escaped first so user text can't inject markup.
function mdStyle(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g,     '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g,  '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/==([^=\s][^=]*?)==/g, '<mark>$1</mark>');            // Obsidian's highlight
}

// CommonMark destination: `<…>` (may hold spaces) or a run whose parentheses balance one level deep.
const DEST = String.raw`<[^<>\n]+>|(?:[^()\s]|\([^()\s]*\))+`;
const unwrapDest = (d: string): string => d.startsWith('<') && d.endsWith('>') ? d.slice(1, -1) : d;

// Obsidian's embed `![[src|…]]`: the `|…` is a width (`200`, `200x100`) or else alt text. An embed of a
// non-picture (`![[Note]]`) reads as a link.
// else alt text. An embed of anything but a picture (`![[Note]]`) isn't one: it reads as a link to it.
const IMG_MD = String.raw`!\[([^\]]*)\]\((${DEST})\)`;
const IMG_EMBED = String.raw`!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]`;
const PICTURE = new RegExp(`${IMG_MD}|${IMG_EMBED}`, 'g');
const SIZE = /^\s*(\d+)(?:x\d+)?\s*$/;

export interface SoleImage { alt: string; src: string; width?: number }

// `at`: where the four picture groups start within a longer pattern's match.
function pictureOf(g: Array<string | undefined>, at = 1): SoleImage | null {
  const [alt, dest, embed, after] = g.slice(at, at + 4);
  if (dest !== undefined) {
    return { alt: (alt ?? '').trim(), src: unwrapDest(dest) };
  }
  const src = embed?.trim() ?? '';
  if (!IMAGE_FILE_RE.test(src)) {
    return null;
  }
  const size = (after ?? '').match(SIZE);
  return size ? { alt: '', src, width: +size[1] } : { alt: (after ?? '').trim(), src };
}

export function imageMd(alt: string, src: string): string {
  return `![${alt}](${/[\s()<>]/.test(src) ? `<${src}>` : src})`;
}

// A link's `My%20Note.md` → the path on disk; invalid %-encoding stays as is.
export function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

// A relative `.md` link (maybe with `#heading`) is followed like a wikilink; anything else is null.
function noteLinkTarget(dest: string): string | null {
  const m = decodePath(dest).match(/^([^:#?]+?)\.md(#.*)?$/i);
  return m ? m[1].replace(/^(?:\.\.?\/)+/, '').replace(/^\//, '') + (m[2] ?? '') : null;
}

// Image alternatives come first so `![..](..)` isn't read as a link with a stray "!".
// Never a scheme that RUNS something (`javascript:`): notes arrive from outside the app.
const SAFE_HREF = /^(https?:|mailto:|[^:]*$)/i;
const LINKS = new RegExp([
  IMG_MD, IMG_EMBED,                                          // 1 alt, 2 dest · 3 embed, 4 after its |
  String.raw`\[([^\]]+)\]\((${DEST})\)`,                       // 5 label, 6 dest
  String.raw`\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`,                 // 7 target, 8 alias
  String.raw`<(https?:\/\/[^\s>]+)>`, String.raw`(https?:\/\/[^\s)]+)`,   // 9, 10
].join('|'), 'g');
const wikilinkTag = (target: string, label: string): string =>
  `<a class="lk wikilink" data-target="${esc(target.trim())}">${esc(label.trim())}</a>`;

function mdLinks(text: string): string {
  let out = '', last = 0;
  for (const m of text.matchAll(LINKS)){
    out += mdEmphasis(text.slice(last, m.index));
    last = m.index + m[0].length;
    const pic = m[2] !== undefined || m[3] !== undefined ? pictureOf(m) : null;
    if (pic) {
      out += imgTag(pic.src, pic.alt, pic.width);
    } else if (m[3] !== undefined) {
      out += wikilinkTag(m[3], m[4] || m[3]);                                            // ![[Note]]
    } else if (m[6] !== undefined) {
      const dest = unwrapDest(m[6]), note = noteLinkTarget(dest);
      if (note) {
        out += `<a class="lk wikilink" data-target="${esc(note)}">${mdEmphasis(m[5])}</a>`;
      } else if (!SAFE_HREF.test(dest)) {
        out += mdEmphasis(m[5]);                                                         // javascript: etc. — text only
      } else {
        out += `<a class="lk" href="${esc(dest)}" target="_blank" rel="noopener">${mdEmphasis(m[5])}</a>`;
      }
    } else if (m[7] !== undefined) {
      out += wikilinkTag(m[7], m[8] || m[7]);
    } else {
      const u = m[9] ?? m[10];                                                           // <url> or a bare one
      out += `<a class="lk" href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`;
    }
  }
  out += mdEmphasis(text.slice(last));
  return out;
}

// A card whose whole note is one picture IS that image (see "A card whose whole note is one image IS
// that image" in docs/architecture.md).
const SOLE = new RegExp(`^(?:${IMG_MD}|${IMG_EMBED})$`);

export function soleImage(body: string | null | undefined): SoleImage | null {
  const m = (body ?? '').trim().match(SOLE);
  return m ? pictureOf(m) : null;
}

export function* bodyImages(body: string | null | undefined): Generator<SoleImage> {
  for (const m of (body ?? '').matchAll(PICTURE)) {
    const pic = pictureOf(m);
    if (pic) {
      yield pic;
    }
  }
}

export function appendMd(body: string, md: string): string {
  return body.trim() ? body.replace(/\s*$/, '') + '\n\n' + md : md;
}

export const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes the picture's line too, if that was all the line held.
export function stripImageRef(body: string, src: string): string {
  for (const m of body.matchAll(PICTURE)) {
    if (pictureOf(m)?.src !== src) {
      continue;
    }
    let from = m.index, to = m.index + m[0].length;
    const before = body.slice(0, from).match(/[ \t]*$/)![0].length, after = body.slice(to).match(/^[ \t]*/)![0].length;
    const lineStart = from - before === 0 || body[from - before - 1] === '\n';
    const lineEnd = to + after === body.length || body[to + after] === '\n';
    if (lineStart && lineEnd) {
      from -= before;
      to += after + (body[to + after] === '\n' ? 1 : 0);
    } else {
      to += after;                                            // one side's space, so the words keep theirs
      if (!after) {
        from -= before;
      }
    }
    return (body.slice(0, from) + body.slice(to)).replace(/\n{3,}/g, '\n\n').trim();
  }
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

// Fenced code is skipped, so a markdown sample in a code block isn't counted.
const TASK_LINE = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])\]\s+\S/;

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

// Asked for every open card on every paint, so it's memoised per text.
const NO_TASKS = { done: 0, total: 0 };
const PROGRESS_CACHE_MAX = 4000;
const progressOf = new Map<string, { done: number; total: number }>();

export function taskProgress(md: string | null | undefined): { done: number; total: number } {
  if (!md || !md.includes('[')) {
    return NO_TASKS;
  }
  const known = progressOf.get(md);
  if (known) {
    return known;
  }
  let done = 0, total = 0;
  for (const t of taskLines(md.split('\n'))) {
    total++;
    if (t.mark !== ' ') {
      done++;
    }
  }
  if (progressOf.size > PROGRESS_CACHE_MAX) {
    progressOf.clear();
  }
  const out = { done, total };
  progressOf.set(md, out);
  return out;
}

// `idx` as the card numbers its checkboxes (`data-ti`).
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

// Pasting a URL over selected text LINKS it. Strict on purpose: `docs/notes.md` over a word is a paste.
const URL_ONLY = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)[^\s<>]+$/i;

// The url group is `*` so a half-written `[label]()` is still recognised.
const LINK_SCAN = /!\[([^\]]*)\]\(([^)\s]*)\)|\[([^\]]+)\]\(([^)\s]*)\)|(https?:\/\/[^\s)]+)/g;

export interface LinkPaste { text: string; start: number; end: number }

// The selection lands on the LABEL; null lets the paste happen natively.
export function linkPaste(text: string, start: number, end: number, url: string): LinkPaste | null {
  const u = url.trim();
  if (start === end || !URL_ONLY.test(u)) {
    return null;
  }
  const sel = text.slice(start, end);
  if (sel.includes('\n')) {
    return null;
  }

  // A link the selection touches gets its URL replaced: a link inside a label would be invalid markdown.
  LINK_SCAN.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = LINK_SCAN.exec(text)); ){
    const ms = m.index, me = ms + m[0].length;
    if (me <= start || ms >= end) {
      continue;
    }
    if (m[1] !== undefined) {
      return null;             // an image's src isn't a link to update
    }
    if (m[5]) {
      return { text: text.slice(0, ms) + u + text.slice(me), start: ms, end: ms + u.length };
    }
    const label = m[3];
    return { text: text.slice(0, ms) + `[${label}](${u})` + text.slice(me), start: ms + 1, end: ms + 1 + label.length };
  }

  // Whitespace the selection caught stays outside the brackets.
  const lead = sel.length - sel.trimStart().length;
  const label = sel.trim();
  if (!label) {
    return null;
  }
  const at = start + lead;
  return { text: text.slice(0, at) + `[${label}](${u})` + text.slice(at + label.length),
           start: at + 1, end: at + 1 + label.length };
}

// The real src is resolved after insertion (hydrateImages), so rendering stays synchronous.
// `data-path` stays so the context menu can map a rendered <img> back to its file.
function imgTag(src: string, alt: string, width?: number): string {
  const s = esc(src.trim()), w = width ? ` style="max-width:${width}px"` : '';
  return `<span class="img-wrap"><img class="md-img" data-img-src="${s}" data-path="${s}" alt="${esc(alt || '')}"${w}>`
    + `<button type="button" class="img-zoom" tabindex="-1" aria-label="View image">`
    + `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><line x1="15.5" y1="15.5" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
    + `</button></span>`;
}

// A backslash escape becomes a private-use stand-in before the link, tag and emphasis passes, and is
// shown again at the end. Inside a code span a backslash is literal.
const ESCAPED = /\\([\\*_[\]()#!=~<>{}+\-.|])/g;
const STAND_IN = /[\uE000-\uE07F]/g;
const STAND_IN_BASE = 0xE000;

// Stand-ins already in the text are dropped, or a note could smuggle e.g. the `:` of `javascript:`.
const hideEscapes = (s: string): string => s.replace(STAND_IN, '')
  .replace(ESCAPED, (_m, c: string) => String.fromCharCode(STAND_IN_BASE + c.charCodeAt(0)));
const showEscapes = (s: string): string => s.replace(STAND_IN, c => esc(String.fromCharCode(c.charCodeAt(0) - STAND_IN_BASE)));

// `code` spans are protected first: nothing is formatted inside them.
export function mdInline(text: string): string {
  let out = '', last = 0;
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))){
    out += mdLinks(hideEscapes(text.slice(last, m.index)));
    out += `<code>${esc(m[1])}</code>`;
    last = re.lastIndex;
  }
  out += mdLinks(hideEscapes(text.slice(last)));
  return showEscapes(out);
}

// Strict GFM: the delimiter row must have the header's cell count, so prose with a `|` stays prose.
// Cells skip the task-list branch: `data-ti` numbers checkboxes by body order.
const TABLE_DELIM_CELL = /^:?-+:?$/;
const UNESCAPED_PIPE = /(?:^|[^\\])\|/;

// Outer pipes are stripped from the LINE, not dropped as cells: `| a | |` has an empty last cell.
export function tableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) {
    s = s.slice(1);
  }
  if (UNESCAPED_PIPE.test(s) && s.endsWith('|')) {
    s = s.slice(0, -1);
  }
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

// Column count if a table starts at line i, else 0.
export function tableAt(lines: string[], i: number): number {
  const head = lines[i], delim = lines[i+1];
  if (head == null || delim == null) {
    return 0;
  }
  if (!UNESCAPED_PIPE.test(head) || !UNESCAPED_PIPE.test(delim)) {
    return 0;
  }
  const dc = tableRow(delim);
  if (!dc.every(c => TABLE_DELIM_CELL.test(c))) {
    return 0;
  }
  return tableRow(head).length === dc.length ? dc.length : 0;
}

function tableAlign(cell: string): string {
  const l = cell.startsWith(':'), r = cell.endsWith(':');
  return l && r ? 'center' : r ? 'right' : '';
}

// Ragged rows are padded/truncated to the header's column count, as GFM does.
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
  while (i < lines.length && lines[i].trim() && UNESCAPED_PIPE.test(lines[i])) {
    body += row(tableRow(lines[i++]), 'td');
  }
  return { html: `<table><thead>${row(tableRow(lines[start]), 'th')}</thead><tbody>${body}</tbody></table>`, next: i };
}

// Indent is compared, never counted in fixed steps, so `  -` and `    -` both nest under `-`. A task's
// text gets a span because the row is a flex box: bare, it would wrap under the checkbox.
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;

function renderList(lines: string[], taskIdx: number): { html: string; taskIdx: number } {
  let html = '';
  const open: Array<{ indent: number; tag: 'ul' | 'ol' }> = [];

  // An ordered list starts at its FIRST item's number, as in CommonMark.
  const opener = (tag: 'ul' | 'ol', marker: string): string =>
    tag === 'ol' && parseInt(marker, 10) !== 1 ? `<ol start="${parseInt(marker, 10)}">` : `<${tag}>`;
  const li = (body: string): string => {
    const tm = body.match(/^\[([ xX])\]\s+(\S.*)$/);
    if (tm) {
      return `<li class="task"><input type="checkbox" class="taskbox" data-ti="${taskIdx++}"`
                 + `${tm[1].toLowerCase()==='x' ? ' checked' : ''}><span class="task-text">${mdInline(tm[2])}</span>`;
    }
    return `<li>${mdInline(body)}`;
  };
  for (const line of lines){
    const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)!;
    const indent = m[1].replace(/\t/g, '  ').length;
    const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
    while (open.length > 1 && indent < open[open.length - 1].indent) {
      html += `</li></${open.pop()!.tag}>`;
    }
    const top = open[open.length - 1];
    if (!top || indent > top.indent){
      html += opener(tag, m[2]); open.push({ indent, tag });
    } else {
      html += '</li>';
      if (tag !== top.tag){ html += `</${top.tag}>` + opener(tag, m[2]); top.tag = tag; }
    }
    html += li(m[3]);
  }
  while (open.length) {
    html += `</li></${open.pop()!.tag}>`;
  }
  return { html, taskIdx };
}

// It ENDS a text run too: a `---` under a line is a rule, never a setext heading.
const HR = /^\s*(?:[-*_]\s*){3,}$/;

export function renderBodyHTML(md: string | null | undefined): string {
  const src = (md || '').replace(/\r\n?/g, '\n').trim();
  if (!src) {
    return '';
  }
  const lines = src.split('\n');
  let html = '', i = 0, taskIdx = 0;
  const BLOCK = /^(#{1,6}\s|```|~~~|\s*>|\s*[-*+]\s|\s*\d+\.\s)/;
  while (i < lines.length){
    const line = lines[i];
    const fence = line.match(/^(```|~~~)/);
    if (fence){
      i++; const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith(fence[1])) {
        code.push(lines[i++]);
      }
      i++;                                                    // closing fence
      html += `<pre><code>${esc(code.join('\n'))}</code></pre>`; continue;
    }
    let h: RegExpMatchArray | null;
    if ((h = line.match(/^(#{1,6})\s+(.*)$/))){
      html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; i++; continue;
    }
    if (HR.test(line)){ html += '<hr>'; i++; continue; }
    const cols = tableAt(lines, i);
    if (cols){ const t = renderTable(lines, i, cols); html += t.html; i = t.next; continue; }
    if (/^\s*>/.test(line)){
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        q.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      html += `<blockquote>${q.map(mdInline).join('<br>')}</blockquote>`; continue;
    }
    if (LIST_ITEM.test(line)){
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]) && !HR.test(lines[i])) {
        items.push(lines[i++]);
      }
      const r = renderList(items, taskIdx);
      html += r.html; taskIdx = r.taskIdx; continue;
    }

    // A run of blank lines is ONE paragraph break: the gap is CSS's margin, not the count of Returns.
    // Within a paragraph a single newline is a <br>.
    const run: string[] = [];
    while (i < lines.length && !BLOCK.test(lines[i]) && !HR.test(lines[i]) && !tableAt(lines, i)) {
      run.push(lines[i++]);
    }
    let para: string[] = [];
    const flushPara = (): void => {
      if (para.length) {
        html += `<p>${para.map(mdInline).join('<br>')}</p>`;
      }
      para = [];
    };
    for (const l of run) {
      if (l.trim()) {
        para.push(l);
      } else {
        flushPara();
      }
    }
    flushPara();
  }
  return html;
}
