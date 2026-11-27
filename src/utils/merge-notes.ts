// What ⌥-dropping cards onto a card MERGES into its note: each titled card under a `## Title` (one level
// below the target's), an untitled one as just its text, a blank line apart.
export function mergedText(cards: Array<{ title: string; body: string }>): string {
  const part = (c: { title: string; body: string }): string => {
    const body = (c.body || '').trim();
    const title = c.title.trim();
    if (!title) {
      return body;
    }
    return body ? `## ${title}\n\n${body}` : `## ${title}`;
  };
  return cards.map(part).filter(Boolean).join('\n\n');
}

// The target's tags, then any the merged cards bring, each once.
export function mergedTags(target: string[], cards: Array<{ tags: string[] }>): string[] {
  const tags = new Set(target);
  for (const c of cards) {
    for (const t of c.tags) {
      tags.add(t);
    }
  }
  return [...tags];
}
