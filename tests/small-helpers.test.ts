import { describe, it, expect } from 'vitest';
import { headingOf, caretIn } from '../src/utils/frontmatter';
import { normalizeColor } from '../src/utils/ink';
import { timeAgo } from '../src/utils/time-ago';

describe('headingOf / caretIn', () => {
  it('finds the title past leading blank lines', () => {
    expect(headingOf('\n\n# Plans\nbody')).toEqual({ at: 4, title: 'Plans' });
  });

  it('selects only the name, never the # marker', () => {
    expect(caretIn('# Plans\nbody', 'title')).toEqual([2, 7]);
  });

  it('puts the caret at the start of an untitled note, and at the end on request', () => {
    expect(caretIn('just text', 'title')).toEqual([0, 0]);
    expect(caretIn('just text', 'end')).toEqual([9, 9]);
  });
});

describe('normalizeColor', () => {
  it('folds case and the short form together', () => {
    expect(normalizeColor(' #FFF ')).toBe('#ffffff');
    expect(normalizeColor('#FFE9A8')).toBe('#ffe9a8');
  });

  it('refuses what is not a hex colour', () => {
    expect(normalizeColor('yellow')).toBe('');
  });
});

describe('timeAgo', () => {
  const now = 1_000_000_000_000;
  it('counts up through minutes, hours and days', () => {
    expect(timeAgo(now - 30_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('says nothing for an entry with no time', () => {
    expect(timeAgo(0, now)).toBe('');
  });
});
