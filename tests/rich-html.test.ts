// A formatted copy is the card's rendering with everything only Corkboard reads taken off (utils/rich-html.ts).
import { describe, expect, it } from 'vitest';
import { portableHtml } from '../src/utils/rich-html.js';
import { renderBodyHTML } from '../src/utils/markdown.js';

const noImages = (): Promise<string | null> => Promise.resolve(null);

describe('portableHtml', () => {
  it('keeps the formatting and drops classes, data attributes, tags and wikilinks', async () => {
    const html = await portableHtml(renderBodyHTML('# Plan\n**bold** and *it* #idea, see [[Other]] or [web](https://x.y)'), noImages);
    expect(html).toBe('<h1>Plan</h1><p><strong>bold</strong> and <em>it</em> #idea, see Other or <a href="https://x.y">web</a></p>');
  });
  it('writes tasks as ☐/☑ text', async () => {
    const html = await portableHtml(renderBodyHTML('- [x] done\n- [ ] todo'), noImages);
    expect(html).toBe('<ul><li>☑ done</li><li>☐ todo</li></ul>');
  });
  it('gives a table borders of its own', async () => {
    const html = await portableHtml(renderBodyHTML('| a | b |\n|---|--:|\n| 1 | 2 |'), noImages);
    expect(html).toContain('<table style="border-collapse:collapse">');
    expect(html).toContain('<td style="border:1px solid #ccc;padding:4px 8px;text-align:right">2</td>');
  });
  it('gives a picture the src it is handed, or its alt text when it cannot be read', async () => {
    const md = '![cat](cat.png) ![dog](dog.png)';
    const html = await portableHtml(renderBodyHTML(md), src => Promise.resolve(src === 'cat.png' ? 'data:image/png;base64,AA' : null));
    expect(html).toBe('<p><img alt="cat" src="data:image/png;base64,AA"> dog</p>');
  });
});
