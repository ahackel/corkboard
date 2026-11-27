// What ⌥-dropping cards onto a card MERGES into its note (features/crud.ts mergeCardsInto). Pure, and pinned
// by tests/merge-notes.test.ts.

// Each card's text, in order, a blank line apart: a titled card under a `## Title` heading (one level below
// the target's own `# ` line), an untitled one as just its text — no heading is invented for it.
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
