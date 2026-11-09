// The card editor's SYNTAX HIGHLIGHT: the raw markdown as HTML that keeps EVERY character of the source,
// in order, wrapped in spans (features/inline-edit.ts lays it behind the transparent textarea). Spans may
// change colour, opacity, background and decoration — never anything that moves a glyph — so the
// painted text stays exactly under the textarea's caret and selection. Pinned by tests/md-highlight.test.ts.
import { esc } from './markdown.js';
import { TAG_CH } from './tags.js';

const span = (cls: string, s: string): string => s ? `<span class="${cls}">${esc(s)}</span>` : '';

// Inline marks, in the order they win where two could start at the same place.
const INLINE = new RegExp([
  String.raw`(?<code>(?<tick>` + '`+' + String.raw`)[^\n]*?\k<tick>)`,
  String.raw`(?<wiki>!?\[\[[^\]\n]+\]\])`,
  String.raw`(?<link>!?\[[^\]\n]*\]\([^)\n]*\))`,
  String.raw`(?<em>(?<m>\*\*|~~|==)(?=\S)[^\n]*?\S\k<m>|\*(?=[^\s*])[^\n*]*?\*`
    // `_` and `__` only at words' edges, so snake_case_word stays plain (as in CommonMark)
    + String.raw`|(?<![\p{L}\p{N}])(?:__(?=\S)[^\n]*?\S__|_(?=[^\s_])[^\n_]*?_)(?![\p{L}\p{N}]))`,
  String.raw`(?<tag>(?<=^|[\s(\[{,;])#${TAG_CH}+)`,
].join('|'), 'gu');

const EM_CLASS: Record<string, string> = { '**':'hl-b', '__':'hl-b', '~~':'hl-s', '==':'hl-mark', '*':'hl-i', '_':'hl-i' };

function inline(s: string): string {
  let out = '', at = 0;
  for (const m of s.matchAll(INLINE)) {
    const t = m[0], g = m.groups ?? {};
    out += esc(s.slice(at, m.index));
    at = m.index + t.length;
    if (g.code) {
      const k = g.tick.length;
      out += `<span class="hl-code">${span('hl-mk', t.slice(0, k))}${esc(t.slice(k, -k))}${span('hl-mk', t.slice(-k))}</span>`;
    } else if (g.wiki) {
      const open = t.startsWith('!') ? 3 : 2;
      out += `<span class="hl-link">${span('hl-mk', t.slice(0, open))}${esc(t.slice(open, -2))}${span('hl-mk', ']]')}</span>`;
    } else if (g.link) {
      const mid = t.indexOf('](');
      const open = t.startsWith('!') ? 2 : 1;
      out += `<span class="hl-link">${span('hl-mk', t.slice(0, open))}${inline(t.slice(open, mid))}</span>${span('hl-mk', t.slice(mid))}`;
    } else if (g.em) {
      const k = /^(\*\*|__|~~|==)/.test(t) ? 2 : 1, mk = t.slice(0, k);
      out += `<span class="${EM_CLASS[mk]}">${span('hl-mk', mk)}${inline(t.slice(k, -k))}${span('hl-mk', mk)}</span>`;
    } else {
      out += span('hl-tag', t);
    }
  }
  return out + esc(s.slice(at));
}

const HEADING = /^(#{1,6})(\s.*)?$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^(\s*>[>\s]*)(.*)$/;
const ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s)?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function line(s: string): string {
  let m: RegExpMatchArray | null;
  if ((m = s.match(HEADING))) {
    return `<span class="hl-h">${span('hl-mk', m[1])}${inline(m[2] ?? '')}</span>`;
  }
  if (RULE.test(s) || (s.includes('|') && TABLE_RULE.test(s))) {
    return span('hl-mk', s);
  }
  if ((m = s.match(QUOTE))) {
    return span('hl-mk', m[1]) + `<span class="hl-q">${inline(m[2])}</span>`;
  }
  if ((m = s.match(ITEM))) {
    const done = m[2] && m[2][1] !== ' ';
    return span('hl-mk', m[1] + (m[2] ?? '')) + (done ? `<span class="hl-done">${inline(m[3])}</span>` : inline(m[3]));
  }
  if (s.trimStart().startsWith('|')) {
    return s.split('|').map(inline).join(span('hl-mk', '|'));
  }
  return inline(s);
}

export function highlightMarkdown(src: string): string {
  let fence = '';
  return src.split('\n').map((s) => {
    const f = s.match(FENCE)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && !s.trim().slice(f.length).trim()) {
        fence = '';
        return span('hl-mk', s);
      }
      return span('hl-code', s);
    }
    if (f) {
      fence = f;
      return span('hl-mk', s);
    }
    return line(s);
  }).join('\n');
}
