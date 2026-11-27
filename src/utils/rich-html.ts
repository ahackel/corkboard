// A note as FORMATTED text for other apps: the card's rendering minus what only this app understands.
// Checkboxes become ☐/☑ (most editors drop a pasted <input>); pictures get `imageSrc`'s data URL or alt text.

const unwrap = (el: Element): void => el.replaceWith(...el.childNodes);

// Inline, since the receiving app lacks our stylesheet: without them a table pastes borderless.
const CELL = 'border:1px solid #ccc;padding:4px 8px';

export async function portableHtml(html: string, imageSrc: (src: string) => Promise<string | null>): Promise<string> {
  const t = document.createElement('template');
  t.innerHTML = html;
  const root = t.content;
  root.querySelectorAll('.img-zoom').forEach(b => b.remove());
  root.querySelectorAll('.img-wrap, .task-text, .md-tag, a.wikilink').forEach(unwrap);
  root.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(box => {
    box.replaceWith(box.hasAttribute('checked') ? '☑ ' : '☐ ');
  });
  root.querySelectorAll('a[href]').forEach(a => {
    a.removeAttribute('target');
    a.removeAttribute('rel');
  });
  root.querySelectorAll('table').forEach(table => table.setAttribute('style', 'border-collapse:collapse'));
  root.querySelectorAll('th, td').forEach(cell => cell.setAttribute('style', `${CELL};${cell.getAttribute('style') ?? ''}`.replace(/;$/, '')));
  await Promise.all([...root.querySelectorAll('img')].map(async img => {
    const path = img.getAttribute('data-path') ?? img.getAttribute('src') ?? '';
    const src = path ? await imageSrc(path) : null;
    if (src) {
      img.setAttribute('src', src);
    } else {
      img.replaceWith(img.getAttribute('alt') || path);
    }
  }));
  for (const el of root.querySelectorAll('*')) {
    for (const { name } of [...el.attributes]) {
      if (name === 'class' || name.startsWith('data-')) {
        el.removeAttribute(name);
      }
    }
  }
  return t.innerHTML;
}
