import { describe, it, expect } from 'vitest';
import { mergedText, mergedTags } from '../src/utils/merge-notes.js';

describe('mergedText', () => {
  it('puts each titled card under a ## heading, a blank line apart', () => {
    expect(mergedText([{ title: 'One', body: 'first' }, { title: 'Two', body: 'second\n' }]))
      .toBe('## One\n\nfirst\n\n## Two\n\nsecond');
  });
  it('invents no heading for an untitled card', () => {
    expect(mergedText([{ title: '', body: '  just text ' }])).toBe('just text');
  });
  it('keeps a title with no body, and drops a card with neither', () => {
    expect(mergedText([{ title: 'Only', body: '' }, { title: ' ', body: '' }, { title: '', body: 'x' }]))
      .toBe('## Only\n\nx');
  });
});

describe('mergedTags', () => {
  it('adds the merged cards’ tags after the target’s own, each once', () => {
    expect(mergedTags(['a', 'b'], [{ tags: ['b', 'c'] }, { tags: ['c', 'd'] }])).toEqual(['a', 'b', 'c', 'd']);
  });
});
