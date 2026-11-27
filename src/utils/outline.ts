// Copied cards as a nested bullet list for other apps; paste-list.ts splits it back into cards.
export interface OutlineItem { text: string; kids: OutlineItem[] }

export function outlineText(items: OutlineItem[]): string {
  const lines: string[] = [];
  const walk = (it: OutlineItem, pad: string): void => {
    const [head, ...rest] = it.text.trim().split('\n');
    lines.push(`${pad}- ${head}`, ...rest.map(l => l.trim() ? `${pad}  ${l}` : ''));
    for (const k of it.kids) {
      walk(k, pad + '  ');
    }
  };
  for (const it of items) {
    walk(it, '');
  }
  return lines.join('\n');
}
