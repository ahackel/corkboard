import { describe, it, expect } from 'vitest';
import { renderBodyHTML, taskProgress, toggleTaskAt, appendMd } from '../src/utils/markdown.js';

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
  it('highlights ==text==, and leaves a lone == alone', () => {
    expect(renderBodyHTML('a ==hot== b')).toBe('<p>a <mark>hot</mark> b</p>');
    expect(renderBodyHTML('a == b')).toBe('<p>a == b</p>');
  });
});

describe('taskProgress', () => {
  it('counts the bullet tasks a card draws as checkboxes, and how many are ticked', () => {
    expect(taskProgress('- [x] a\n- [ ] b\n  * [X] c\n+ [ ] d')).toEqual({ done: 2, total: 4 });
  });
  it('leaves out numbered items, empty boxes, plain bullets and fenced code', () => {
    expect(taskProgress('1. [x] no\n- [ ]\n- plain\n```\n- [x] sample\n```\n- [ ] yes')).toEqual({ done: 0, total: 1 });
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
    for (const md of ['- [x] a\n- [ ] b', '1. [ ] no\n- [ ]\n- [ ] yes', '~~~\n- [ ] x\n~~~\n* [X] y', '- [ ]  \n- [ ] b']) {
      expect(checkboxes(md)).toBe(taskProgress(md).total);
    }
  });
});

describe('appendMd', () => {
  it('adds to the end of a note over one blank line, or is the whole of an empty one', () => {
    expect(appendMd('a\n\n', '![](x.png)')).toBe('a\n\n![](x.png)');
    expect(appendMd('  ', '![](x.png)')).toBe('![](x.png)');
  });
});
