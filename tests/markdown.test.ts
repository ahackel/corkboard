import { describe, it, expect } from 'vitest';
import { renderBodyHTML } from '../src/utils/markdown.js';

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
