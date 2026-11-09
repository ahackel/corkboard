// ---------- rich text pasted in becomes markdown ----------
// Text copied from a web page, Google Docs, Word or Notion carries its links, bold, lists and tables only in
// the clipboard's `text/html`; its `text/plain` has dropped them. This writes that HTML as the little markdown
// the card draws (utils/markdown.ts renderBodyHTML) — and nothing it doesn't draw: colours, fonts and layout
// go. Pure (the browser's own DOMParser does the reading), pinned by tests/html-md.test.ts.
// Null when the HTML holds nothing plain text would lose — a code editor's coloured spans, a lone word — so
// the paste stays the plain one.

// Elements whose presence makes the HTML worth reading.
const STRUCTURE = 'a[href], b, strong, i, em, del, s, strike, mark, code, pre, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, table, hr, img[src]';
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'DL', 'DT', 'DD', 'ADDRESS']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'TEMPLATE', 'NOSCRIPT', 'BUTTON', 'svg', 'SVG']);

export function htmlToMarkdown(html: string): string | null {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  if (!body.querySelector(STRUCTURE) || !meaningful(body)) {
    return null;
  }
  const md = blocks(body).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return md || null;
}
// Google Docs wraps a whole copy in `<b style="font-weight:normal">`, so a bold tag alone isn't structure.
function meaningful(body: HTMLElement): boolean {
  return [...body.querySelectorAll<HTMLElement>(STRUCTURE)].some(el => !(isTag(el, 'B') && !bold(el)));
}
const isTag = (el: Element, tag: string): boolean => el.tagName.toUpperCase() === tag;
const weight = (el: HTMLElement): string => el.style?.fontWeight ?? '';
function bold(el: HTMLElement): boolean {
  const w = weight(el);
  if (isTag(el, 'B') || isTag(el, 'STRONG')) {
    return !(w === 'normal' || w === '400' || w === 'lighter');
  }
  return w === 'bold' || w === 'bolder' || +w >= 600;
}
const italic = (el: HTMLElement): boolean => isTag(el, 'I') || isTag(el, 'EM') || el.style?.fontStyle === 'italic';
const struck = (el: HTMLElement): boolean =>
  isTag(el, 'DEL') || isTag(el, 'S') || isTag(el, 'STRIKE') || (el.style?.textDecoration ?? '').includes('line-through');

// ---- blocks ----
// A node's children as markdown blocks: runs of inline content become paragraphs, block elements their own.
function blocks(node: Node): string[] {
  const out: string[] = [];
  let run = '';
  const flush = (): void => {
    const p = tidyLines(run).split('\n').map(escapeLead).join('\n');
    if (p) {
      out.push(p);
    }
    run = '';
  };
  for (const child of node.childNodes) {
    const el = child.nodeType === 1 ? child as HTMLElement : null;
    if (el && SKIP.has(el.tagName)) {
      continue;
    }
    if (!el || (!BLOCK.has(el.tagName.toUpperCase()) && !holdsBlocks(el))) {
      run += inline(child);
      continue;
    }
    flush();
    // An inline element wrapping whole blocks (Google Docs puts a copy in one `<b>`) is only a wrapper.
    out.push(...(BLOCK.has(el.tagName.toUpperCase()) ? block(el) : blocks(el)));
  }
  flush();
  return out;
}
const BLOCK_SELECTOR = [...BLOCK].join(',');
const holdsBlocks = (el: HTMLElement): boolean => !isTag(el, 'A') && !!el.querySelector(BLOCK_SELECTOR);
function block(el: HTMLElement): string[] {
  const tag = el.tagName.toUpperCase();
  const h = tag.match(/^H([1-6])$/);
  if (h) {
    const text = oneLine(inline(el));
    return text ? ['#'.repeat(+h[1]) + ' ' + text] : [];
  }
  if (tag === 'UL' || tag === 'OL') {
    const lines = list(el, '');
    return lines.length ? [lines.join('\n')] : [];
  }
  if (tag === 'PRE') {
    const code = (el.textContent ?? '').replace(/\n$/, '');
    return code.trim() ? ['```\n' + code + '\n```'] : [];
  }
  if (tag === 'BLOCKQUOTE') {
    const inner = blocks(el).join('\n\n');
    return inner ? [inner.split('\n').map(l => l ? '> ' + l : '>').join('\n')] : [];
  }
  if (tag === 'TABLE') {
    const t = table(el);
    return t ? [t] : [];
  }
  if (tag === 'HR') {
    return ['---'];
  }
  return blocks(el);
}
// A list, its items at `indent`; a nested list goes under its item, indented to the item's text (where
// CommonMark and Obsidian read it as nested). A checkbox in an item makes it a task. Google Docs writes a
// nested item as a flat one with `aria-level`, which is read as its depth.
function list(el: HTMLElement, indent: string): string[] {
  const ordered = isTag(el, 'OL');
  let n = ordered ? parseInt(el.getAttribute('start') ?? '1', 10) || 1 : 0;
  const lines: string[] = [];
  for (const li of el.children) {
    if (!isTag(li, 'LI')) {
      if (isTag(li, 'UL') || isTag(li, 'OL')) {
        lines.push(...list(li as HTMLElement, indent + '  '));
      }
      continue;
    }
    const marker = ordered ? `${n++}. ` : '- ';
    const level = Math.max(0, (parseInt(li.getAttribute('aria-level') ?? '1', 10) || 1) - 1);
    const pad = indent + ' '.repeat(marker.length).repeat(level);
    const box = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    const task = box && box.closest('li') === li ? (box.checked || box.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
    let text = '';
    const nested: string[] = [];
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (isTag(c as Element, 'UL') || isTag(c as Element, 'OL'))) {
        nested.push(...list(c as HTMLElement, pad + ' '.repeat(marker.length)));
      } else if (c.nodeType === 1 && BLOCK.has((c as Element).tagName.toUpperCase())) {
        text += ' ' + blocks(c).join(' ');
      } else {
        text += inline(c);
      }
    }
    lines.push(pad + marker + task + oneLine(text), ...nested);
  }
  return lines;
}
function table(el: HTMLElement): string {
  const rows = [...el.querySelectorAll('tr')].filter(r => r.closest('table') === el)
    .map(r => [...r.children].filter(c => isTag(c, 'TD') || isTag(c, 'TH'))
      .map(c => oneLine(inline(c)).replace(/\|/g, '\\|')));
  const cols = Math.max(0, ...rows.map(r => r.length));
  if (!rows.length || !cols) {
    return '';
  }
  const line = (r: string[]): string => '| ' + Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ') + ' |';
  return [line(rows[0]), '| ' + Array(cols).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
}

// ---- inline ----
function inline(node: Node): string {
  if (node.nodeType === 3) {
    return escapeText((node.textContent ?? '').replace(/\s+/g, ' '));
  }
  if (node.nodeType !== 1) {
    return '';
  }
  const el = node as HTMLElement, tag = el.tagName.toUpperCase();
  if (SKIP.has(el.tagName) || isTag(el, 'INPUT')) {
    return '';
  }
  if (tag === 'BR') {
    return '\n';
  }
  if (tag === 'IMG') {
    const src = el.getAttribute('src') ?? '';
    return /^https?:/i.test(src) ? `![${oneLine(el.getAttribute('alt') ?? '')}](${dest(src)})` : '';
  }
  if (tag === 'CODE' && !el.closest('pre')) {
    const code = (el.textContent ?? '').replace(/\s+/g, ' ');
    return code.trim() ? '`' + code + '`' : '';
  }
  if (BLOCK.has(tag)) {
    return ' ' + blocks(el).join(' ') + ' ';
  }
  let inner = '';
  for (const c of el.childNodes) {
    inner += inline(c);
  }
  if (tag === 'A') {
    const href = el.getAttribute('href') ?? '';
    const label = oneLine(inner);
    if (!/^(https?:|mailto:)/i.test(href)) {
      return inner;
    }
    return !label || label === href ? href : `[${label}](${dest(href)})`;
  }
  if (struck(el)) {
    inner = wrap(inner, '~~');
  }
  if (isTag(el, 'MARK')) {
    inner = wrap(inner, '==');
  }
  if (italic(el)) {
    inner = wrap(inner, '*');
  }
  if (bold(el)) {
    inner = wrap(inner, '**');
  }
  return inner;
}
// Emphasis hugs the words: a space the selection caught stays outside the marks, or they wouldn't read.
function wrap(s: string, mark: string): string {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? m[1] + mark + m[2] + mark + m[3] : s;
}
// A link or picture address, in the `<…>` form when it holds a space or an angle bracket.
const dest = (u: string): string => /[\s<>]/.test(u) ? `<${u}>` : u;
// Characters that would turn plain words into markup are escaped (utils/markdown.ts prints `\*` as `*`) — only
// those: an underscore only where it could start or end emphasis, so `snake_case` stays as it is, and a bracket
// only as the start of a `[[link`, so a footnote's `[1]` reads as written.
const escapeText = (s: string): string => s
  .replace(/([*`])/g, '\\$1').replace(/(^|\W)_|_(?=\W|$)/g, m => m.replace('_', '\\_'))
  .replace(/\[\[/g, '\\[[').replace(/==/g, '\\==').replace(/~~/g, '\\~~');
// …and a paragraph line that would read as a heading, a list item or a quote.
const escapeLead = (l: string): string => l.replace(/^(#{1,6}\s|[-+]\s|>)/, '\\$1').replace(/^(\d+)\.(\s)/, '$1\\.$2');
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
const tidyLines = (s: string): string => s.split('\n').map(l => l.replace(/ {2,}/g, ' ').trim()).join('\n').replace(/\n{2,}/g, '\n').trim();
