import { describe, it, expect } from 'vitest';
import { renderBodyHTML, taskProgress, toggleTaskAt, appendMd, xmlSafe, bodyImages, soleImage, stripImageRef, imageMd } from '../src/utils/markdown.js';

describe('renderBodyHTML', () => {
  it('draws a rule for ---, ***, ___ — even straight under a line of text', () => {
    expect(renderBodyHTML('a\n---\nb')).toBe('<p>a</p><hr><p>b</p>');
    expect(renderBodyHTML('a\n\n***\n\n_ _ _')).toBe('<p>a</p><hr><hr>');
    expect(renderBodyHTML('- a\n---')).toBe('<ul><li>a</li></ul><hr>');
  });
  it('starts an ordered list at its first number', () => {
    expect(renderBodyHTML('3. c\n4. d')).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
    expect(renderBodyHTML('1. a')).toBe('<ol><li>a</li></ol>');
  });
  it('fences code with ``` or ~~~, a language tag ignored', () => {
    expect(renderBodyHTML('~~~\n<b>\n~~~')).toBe('<pre><code>&lt;b&gt;</code></pre>');
    expect(renderBodyHTML('```js\nx ~~~\n```')).toBe('<pre><code>x ~~~</code></pre>');
  });
  it('links an <autolink> without its brackets', () => {
    expect(renderBodyHTML('see <https://x.y/a>')).toBe('<p>see <a class="lk" href="https://x.y/a" target="_blank" rel="noopener">https://x.y/a</a></p>');
  });
  it('drops a private-use stand-in a note brings itself, so it cannot spell a scheme', () => {
    const html = renderBodyHTML('[x](javascript\uE03Aalert(1))');
    expect(html).not.toContain('javascript:');
  });
  it('links only to addresses that cannot run code', () => {
    expect(renderBodyHTML('[go](javascript:alert(1))')).toBe('<p>go</p>');
    expect(renderBodyHTML('[w](https://x.y)')).toContain('href="https://x.y"');
    expect(renderBodyHTML('[m](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
  });
  it('highlights ==text==, and leaves a lone == alone', () => {
    expect(renderBodyHTML('a ==hot== b')).toBe('<p>a <mark>hot</mark> b</p>');
    expect(renderBodyHTML('a == b')).toBe('<p>a == b</p>');
  });
});

describe('renderBodyHTML lists', () => {
  it('nests by indentation', () => {
    expect(renderBodyHTML('- a\n  - b\n  - c\n- d'))
      .toBe('<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>');
  });
  it('nests a bullet under a number and switches kind at one level', () => {
    expect(renderBodyHTML('1. a\n   - b\n2. c'))
      .toBe('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
    expect(renderBodyHTML('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });
  it('closes several levels at once', () => {
    expect(renderBodyHTML('- a\n  - b\n    - c\n- d'))
      .toBe('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  });
  it('numbers tasks in body order through nesting, for write-back', () => {
    const h = renderBodyHTML('- [ ] a\n  - [x] b\n- [ ] c');
    expect([...h.matchAll(/data-ti="(\d)"( checked)?/g)].map(m => m[1] + (m[2] ? 'x' : ''))).toEqual(['0', '1x', '2']);
    expect(h).toContain('<span class="task-text">a</span><ul>');
  });
});

describe('taskProgress', () => {
  it('counts the bullet tasks a card draws as checkboxes, and how many are ticked', () => {
    expect(taskProgress('- [x] a\n- [ ] b\n  * [X] c\n+ [ ] d')).toEqual({ done: 2, total: 4 });
  });
  it('counts numbered tasks too, as Obsidian draws them', () => {
    expect(taskProgress('1. [x] a\n2. [ ] b')).toEqual({ done: 1, total: 2 });
  });
  it('leaves out empty boxes, plain bullets and fenced code', () => {
    expect(taskProgress('- [ ]\n- plain\n```\n- [x] sample\n```\n- [ ] yes')).toEqual({ done: 0, total: 1 });
    expect(taskProgress('')).toEqual({ done: 0, total: 0 });
  });
});

describe('toggleTaskAt', () => {
  const checkboxes = (md: string): number => (renderBodyHTML(md).match(/data-ti=/g) ?? []).length;

  it('ticks the task its checkbox stands for, past a sample in fenced code', () => {
    const md = '```\n- [ ] sample\n```\n- [ ] first\n- [ ] second';
    expect(toggleTaskAt(md, 1)).toBe('```\n- [ ] sample\n```\n- [ ] first\n- [x] second');
  });

  it('skips an empty box, which draws no checkbox', () => {
    expect(toggleTaskAt('- [ ]\n- [x] done', 0)).toBe('- [ ]\n- [ ] done');
  });

  it('numbers exactly the checkboxes the card draws', () => {
    for (const md of ['- [x] a\n- [ ] b', '1. [ ] yes\n- [ ]\n- [ ] yes', '~~~\n- [ ] x\n~~~\n* [X] y', '- [ ]  \n- [ ] b']) {
      expect(checkboxes(md)).toBe(taskProgress(md).total);
    }
  });
});

describe('Obsidian links and pictures', () => {
  const img = (html: string): string | undefined => html.match(/data-img-src="([^"]*)"/)?.[1];
  it('draws an embed as a picture, its |number a width and anything else its alt', () => {
    expect(img(renderBodyHTML('![[Pasted image 1.png]]'))).toBe('Pasted image 1.png');
    expect(renderBodyHTML('![[x.png|200]]')).toContain('style="max-width:200px"');
    expect(renderBodyHTML('![[x.png|a cat]]')).toContain('alt="a cat"');
  });
  it('reads an embed of a note as a link to it', () => {
    const html = renderBodyHTML('![[Some Note]]');
    expect(html).toContain('class="lk wikilink" data-target="Some Note"');
    expect(html).not.toContain('!');
  });
  it('takes a <…> path with spaces, and parentheses that balance', () => {
    expect(img(renderBodyHTML('![](<my pic.png>)'))).toBe('my pic.png');
    expect(renderBodyHTML('[w](https://en.wikipedia.org/wiki/Foo_(bar))')).toContain('href="https://en.wikipedia.org/wiki/Foo_(bar)"');
  });
  it('follows a markdown link to a .md note like a wikilink', () => {
    expect(renderBodyHTML('[n](Other%20Note.md)')).toContain('data-target="Other Note"');
    expect(renderBodyHTML('[n](<../Ideas/My Note.md#Plan>)')).toContain('data-target="Ideas/My Note#Plan"');
    expect(renderBodyHTML('[f](attachments/a.pdf)')).toContain('href="attachments/a.pdf"');
  });
  it('finds every kind of picture, and a sole embed makes an image card', () => {
    expect([...bodyImages('![a](x.png) ![[y.jpg|50]] ![[Note]]')]).toEqual([
      { alt: 'a', src: 'x.png' }, { alt: '', src: 'y.jpg', width: 50 }]);
    expect(soleImage('![[y.jpg]]')).toEqual({ alt: '', src: 'y.jpg' });
    expect(soleImage('![[Note]]')).toBeNull();
  });
  it('takes out one picture of either kind, with its line', () => {
    expect(stripImageRef('a\n![[y.jpg]]\nb', 'y.jpg')).toBe('a\nb');
    expect(stripImageRef('a ![](<my pic.png>) b', 'my pic.png')).toBe('a b');
  });
  it('writes a path with a space back in the <…> form', () => {
    expect(imageMd('', 'my pic.png')).toBe('![](<my pic.png>)');
    expect(imageMd('x', 'a.png')).toBe('![x](a.png)');
  });
});

describe('backslash escapes', () => {
  it('print the character and nothing more', () => {
    expect(renderBodyHTML('\\*not italic\\*')).toBe('<p>*not italic*</p>');
    expect(renderBodyHTML('\\#notatag and \\[[not a link]]')).toBe('<p>#notatag and [[not a link]]</p>');
    expect(renderBodyHTML('a \\<b\\> c')).toBe('<p>a &lt;b&gt; c</p>');
  });
  it('are literal inside code', () => {
    expect(renderBodyHTML('`\\*x\\*`')).toBe('<p><code>\\*x\\*</code></p>');
  });
});

describe('numbered tasks', () => {
  it('draw a checkbox and keep their number', () => {
    const html = renderBodyHTML('1. [ ] one\n2. [x] two');
    expect(html).toMatch(/^<ol><li class="task"><input type="checkbox" class="taskbox" data-ti="0">/);
    expect(html).toContain('data-ti="1" checked');
  });
});

describe('appendMd', () => {
  it('adds to the end of a note over one blank line, or is the whole of an empty one', () => {
    expect(appendMd('a\n\n', '![](x.png)')).toBe('a\n\n![](x.png)');
    expect(appendMd('  ', '![](x.png)')).toBe('![](x.png)');
  });
});

describe('xmlSafe', () => {
  it('drops the characters XML forbids and keeps tabs, newlines and emoji', () => {
    expect(xmlSafe('a\u000Bb\u0001c\t\n😀\uD83D')).toBe('abc\t\n😀');
  });
});
