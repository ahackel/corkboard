// A note as FORMATTED text other apps read (features/clipboard.ts copyFormatted): the card's own rendering
// (renderBodyHTML) with everything only this app understands taken off — classes, data attributes, the
// image magnifier, wikilinks and tags (plain text there), task checkboxes (☐/☑, which every editor keeps;
// a pasted <input> is dropped by most). A picture gets the src `imageSrc` gives it (a data URL, so it
// travels with the text), or its alt text when it can't be read. Tested (tests/rich-html.test.ts).

const unwrap = (el: Element): void => el.replaceWith(...el.childNodes);

// Inline, since the receiving app has none of our stylesheet: without them a table pastes borderless.
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
