// Rich text pasted into a card becomes the markdown the card draws (utils/html-md.ts).
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from '../src/utils/html-md.js';

describe('htmlToMarkdown', () => {
  it('keeps links, bold, italic, strike and code', () => {
    expect(htmlToMarkdown('<p>See <a href="https://x.y/a">the <b>docs</b></a>, <em>now</em> or <del>never</del>: <code>npm i</code></p>'))
      .toBe('See [the **docs**](https://x.y/a), *now* or ~~never~~: `npm i`');
  });
  it('writes headings, nested lists, tasks and quotes', () => {
    const html = '<h2>Plan</h2><ul><li>one<ul><li>deep</li></ul></li><li><input type="checkbox" checked> done</li></ul>'
      + '<ol start="3"><li>three</li><li>four</li></ol><blockquote><p>wise</p></blockquote>';
    expect(htmlToMarkdown(html)).toBe('## Plan\n\n- one\n  - deep\n- [x] done\n\n3. three\n4. four\n\n> wise');
  });
  it('writes a table, its first row the header', () => {
    expect(htmlToMarkdown('<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ada</td><td>36</td></tr></table>'))
      .toBe('| Name | Age |\n| --- | --- |\n| Ada | 36 |');
  });
  it('reads Google Docs: a normal-weight wrapper is not bold, a styled span is, aria-level nests', () => {
    const html = '<b style="font-weight:normal" id="docs-internal-guid-1"><p><span>plain </span><span style="font-weight:700">loud</span></p>'
      + '<ul><li aria-level="1"><p>top</p></li><li aria-level="2"><p>under</p></li></ul></b>';
    expect(htmlToMarkdown(html)).toBe('plain **loud**\n\n- top\n  - under');
  });
  it('is null for HTML plain text would not lose anything of', () => {
    expect(htmlToMarkdown('<div><span style="color:red">const</span> <span>x = 1</span></div>')).toBeNull();
    expect(htmlToMarkdown('<b style="font-weight:normal"><span>just text</span></b>')).toBeNull();
  });
  it('escapes what would read as markup, and nothing more', () => {
    expect(htmlToMarkdown('<p><a href="https://a.b">x</a> 2*3, snake_case, _under_ [1]</p><p># not a heading</p>'))
      .toBe('[x](https://a.b) 2\\*3, snake_case, \\_under\\_ [1]\n\n\\# not a heading');
  });
  it('keeps web pictures, drops a link to nowhere', () => {
    expect(htmlToMarkdown('<p><img src="https://x.y/cat.png" alt="cat"> <a href="javascript:x()">click</a></p>'))
      .toBe('![cat](https://x.y/cat.png) click');
  });
});
