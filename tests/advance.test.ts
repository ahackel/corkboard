// The smart duplicate's next title (utils/advance.ts).
import { describe, expect, it } from 'vitest';
import { advanceTitle } from '../src/utils/advance.js';

describe('advanceTitle', () => {
  it('steps a date by a day, and its weekday with it', () => {
    expect(advanceTitle('2026-10-27 Tuesday')).toBe('2026-10-28 Wednesday');
    expect(advanceTitle('2026-12-31 Thursday')).toBe('2027-01-01 Friday');
    expect(advanceTitle('2028-02-28')).toBe('2028-02-29');
    expect(advanceTitle('Log 2026-10-30 fri')).toBe('Log 2026-10-31 sat');
    expect(advanceTitle('2026-10-26 MONTAG')).toBe('2026-10-27 DIENSTAG');
  });
  it('counts the last number up, keeping its padding', () => {
    expect(advanceTitle('Sprint 4')).toBe('Sprint 5');
    expect(advanceTitle('v1.2')).toBe('v1.3');
    expect(advanceTitle('Week 09')).toBe('Week 10');
    expect(advanceTitle('Day 9 of 30')).toBe('Day 9 of 31');
  });
  it('treats an impossible date as plain numbers, and leaves text without any alone', () => {
    expect(advanceTitle('2026-13-45')).toBe('2026-13-46');
    expect(advanceTitle('Ideas')).toBe('Ideas');
  });
});
