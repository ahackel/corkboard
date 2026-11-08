import { describe, it, expect } from 'vitest';
import { outlineText } from '../src/utils/outline.js';
import { splitPastedList } from '../src/utils/paste-list.js';

describe('outlineText', () => {
  it('bullets cards, hangs the rest of a note under its first line, nests a section', () => {
    const text = outlineText([
      { text: 'Week 12', kids: [{ text: 'Shipped\n\n- [x] export', kids: [] }, { text: 'Fixed drag', kids: [] }] },
      { text: 'Loose idea', kids: [] },
    ]);
    expect(text).toBe('- Week 12\n  - Shipped\n\n    - [x] export\n  - Fixed drag\n- Loose idea');
  });
  it('pastes back as one card per top-level item', () => {
    const text = outlineText([{ text: 'A\nmore', kids: [] }, { text: 'B', kids: [] }]);
    expect(splitPastedList(text)).toEqual(['A\nmore', 'B']);
  });
});
