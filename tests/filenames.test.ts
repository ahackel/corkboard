// A note's filename tracks its text, never collides (case-insensitively), and a rename carries
// the [[wikilinks]] that point at it.
import { describe, expect, it } from 'vitest';
import { safeName, slugStem, desiredFileFor, retargetLinks } from '../src/utils/filenames.js';

const node = (title: string, body = '', file: string | null = null, id = 'me') => ({ id, file, title, body });

describe('slugStem', () => {
  it('uses the title, else the first line without its marker', () => {
    expect(slugStem(node('Groceries', '- milk'))).toBe('Groceries');
    expect(slugStem(node('', '- milk\n- eggs'))).toBe('milk');
  });
  it('names an image card after its picture', () => {
    expect(slugStem(node('', '![A cat](attachments/x.png)'))).toBe('A cat');
    expect(slugStem(node('', '![](attachments/photo.png)'))).toBe('photo.png');
  });
  it('strips characters no filesystem allows', () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(safeName('  many   spaces ')).toBe('many spaces');
    expect(safeName('x'.repeat(300))).toHaveLength(120);
  });
});

describe('desiredFileFor', () => {
  it('keeps the directory and tracks the title', () => {
    expect(desiredFileFor(node('New name', '', 'sub/Old.md'), new Map())).toBe('sub/New name.md');
  });
  it('suffixes a collision, case-insensitively', () => {
    const inUse = new Map([['notes.md', 'other'], ['notes 2.md', 'third']]);
    expect(desiredFileFor(node('Notes'), inUse)).toBe('Notes 3.md');
  });
  it('does not collide with itself', () => {
    expect(desiredFileFor(node('Notes', '', 'Notes.md'), new Map([['notes.md', 'me']]))).toBe('Notes.md');
  });
  it('keeps the name of a note with nothing to be named off', () => {
    expect(desiredFileFor(node('', '', 'Something.md'), new Map())).toBe('Something.md');
    expect(desiredFileFor(node(''), new Map())).toBe('Untitled.md');
  });
});

describe('retargetLinks', () => {
  const renames = new Map([['Old.md', 'New.md'], ['dir/A.md', 'dir/B.md']]);
  it('re-points path links, keeping aliases', () => {
    expect(retargetLinks('see [[Old]] and [[old.md|this]]', renames)).toBe('see [[New]] and [[New|this]]');
    expect(retargetLinks('[[dir/A]]', renames)).toBe('[[dir/B]]');
  });
  it('leaves other links and plain text alone', () => {
    const body = '[[Other]] and Old and [Old](Old.md)';
    expect(retargetLinks(body, renames)).toBe(body);
  });
});
