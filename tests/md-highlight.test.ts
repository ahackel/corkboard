// The card editor's syntax highlight (utils/md-highlight.ts).
import { describe, expect, it } from 'vitest';
import { highlightMarkdown } from '../src/utils/md-highlight.js';

const text = (html: string): string => html.replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const SAMPLE = [
  '# Title with #tag and **bold**',
  '',
  'Some *em*, _em_, ~~gone~~, ==marked==, `code` and ``a ` tick``.',
  '- item with [a link](https://x.y/?a=1&b=<2>) and [[Other note]]',
  '  1. nested',
  '- [ ] open task',
  '- [x] done task',
  '> quoted **text**',
  '---',
  '| a | b |',
  '|---|:-:|',
  '| 1 | 2 |',
  '```js',
  'const x = "<b>" && 1 * 2 * 3;',
  '```',
  '![pic](a b.png) ![[img.png]] url#notatag 5 * 3 * 2 snake_case_word',
  'unclosed **bold and `tick',
].join('\n');

describe('highlightMarkdown', () => {
  it('keeps every character of the source, in order', () => {
    expect(text(highlightMarkdown(SAMPLE))).toBe(SAMPLE);
    for (const s of ['', '\n', '#', '* ', '**', '``', '[[', '](', '<script>', 'a\n\n\nb']) {
      expect(text(highlightMarkdown(s))).toBe(s);
    }
  });
  it('dims the markers and marks the spans', () => {
    const h = highlightMarkdown(SAMPLE);
    expect(h).toContain('<span class="hl-h"><span class="hl-mk">#</span>');
    expect(h).toContain('<span class="hl-tag">#tag</span>');
    expect(h).toContain('<span class="hl-b"><span class="hl-mk">**</span>bold');
    expect(h).toContain('<span class="hl-mark">');
    expect(h).toContain('<span class="hl-done">done task</span>');
    expect(h).toContain('<span class="hl-code">const x');
    expect(h).not.toContain('hl-tag">#notatag');
  });
  it('leaves an arithmetic star and a snake_case word alone', () => {
    const h = highlightMarkdown('5 * 3 * 2 and snake_case_word');
    expect(h).not.toContain('hl-i');
  });
});
