import { describe, it, expect } from 'vitest';
import { splitPastedList } from '../src/utils/paste-list.js';

describe('splitPastedList', () => {
  it('splits a bulleted list, any marker', () => {
    expect(splitPastedList('- one\n* two\n+ three\n• four')).toEqual(['one', 'two', 'three', 'four']);
  });
  it('splits a numbered list and drops checkboxes', () => {
    expect(splitPastedList('1. a\n2) b\n3. [x] c\n- [ ] d')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('keeps nested lines with their item, dedented', () => {
    expect(splitPastedList('- idea\n  - detail\n  - more\n- next')).toEqual(['idea\n- detail\n- more', 'next']);
  });
  it('allows blank lines between items', () => {
    expect(splitPastedList('- a\n\n- b\n')).toEqual(['a', 'b']);
  });
  it('splits bare short lines', () => {
    expect(splitPastedList('alpha\r\nbeta\ngamma')).toEqual(['alpha', 'beta', 'gamma']);
  });
  it('leaves a note alone', () => {
    expect(splitPastedList('one line')).toBeNull();
    expect(splitPastedList('- just one item')).toBeNull();
    expect(splitPastedList('# Title\nbody\nmore')).toBeNull();
    expect(splitPastedList('para one\n\npara two')).toBeNull();
    expect(splitPastedList('Shopping:\n- milk\n- eggs')).toBeNull();
    expect(splitPastedList('- a\nlead out')).toBeNull();
    expect(splitPastedList('x\n' + 'y'.repeat(300))).toBeNull();
  });
});
