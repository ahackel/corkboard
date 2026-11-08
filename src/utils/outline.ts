// Copied cards as text OTHER apps read (features/clipboard.ts): a nested bullet list. A card's first
// line is its bullet and the rest of its note hangs under it; a section's cards nest under its name.
// Pasted back onto a board it splits into cards again (paste-list.ts). Pure, so tests pin it down.
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
