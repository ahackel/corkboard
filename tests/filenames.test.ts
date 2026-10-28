// A note's filename tracks its text, never collides (case-insensitively), and a rename carries
// the [[wikilinks]] that point at it.
import { describe, expect, it } from 'vitest';
import { safeName, slugStem, desiredFileFor, retargetLinks, parentFileOf, isSectionNote, prunableDirs } from '../src/utils/filenames.js';

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
  it('never ends in a dot or contains `..`, so a sentence makes a valid filename', () => {
    expect(safeName('Spend it to move.')).toBe('Spend it to move');
    expect(safeName('Wait...')).toBe('Wait');
    expect(safeName('a..b')).toBe('a.b');
    expect(safeName('.hidden')).toBe('hidden');
    expect(safeName('...')).toBe('Untitled');
    expect(safeName('v1.2 notes')).toBe('v1.2 notes');
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
  it('keeps the old name when only the case changed', () => {
    expect(desiredFileFor(node('Notes', '', 'notes.md'), new Map([['notes.md', 'me']]))).toBe('notes.md');
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

describe('a section is a folder', () => {
  const section = (title: string, file: string | null = null, id = 'f') => ({ ...node(title, '', file, id), type: 'section' as const });
  it('reads a parent off the folder', () => {
    expect(parentFileOf('Card.md')).toBe(null);
    expect(parentFileOf('Ideas/Card.md')).toBe('Ideas/_index.md');
    expect(parentFileOf('Ideas/_index.md')).toBe(null);
    expect(parentFileOf('Ideas/Sub/_index.md')).toBe('Ideas/_index.md');
    expect(parentFileOf('Ideas/Sub/Card.md')).toBe('Ideas/Sub/_index.md');
    expect(isSectionNote('A/_INDEX.md')).toBe(true);
  });
  it('puts a section in a folder of its own and a card in its section\'s folder', () => {
    expect(desiredFileFor(section('Ideas'), new Map(), '')).toBe('Ideas/_index.md');
    expect(desiredFileFor(section('Sub', 'Old/_index.md'), new Map(), 'Ideas/')).toBe('Ideas/Sub/_index.md');
    expect(desiredFileFor(node('Milk', '', 'Milk.md'), new Map(), 'Todo/')).toBe('Todo/Milk.md');
  });
  it('suffixes a section folder that collides, and never takes a folder that is something else\'s', () => {
    expect(desiredFileFor(section('Ideas'), new Map([['ideas/_index.md', 'other']]), '')).toBe('Ideas 2/_index.md');
    expect(desiredFileFor(section('Attachments'), new Map(), '', new Set(['attachments/']))).toBe('Attachments 2/_index.md');
  });
  it('keeps a nameless section\'s folder name as it moves', () => {
    expect(desiredFileFor(section('', 'Box 3/_index.md'), new Map(), 'Ideas/')).toBe('Ideas/Box 3/_index.md');
  });
  it('never names a card _index', () => {
    expect(desiredFileFor(node('_index'), new Map(), 'A/')).toBe('A/_index 2.md');
  });
});

describe('prunableDirs', () => {
  it('climbs from each emptied folder, deepest first, keeping any folder that still holds a note', () => {
    expect(prunableDirs(['A/B/C/'], ['A/keep.md'])).toEqual(['A/B/C/', 'A/B/']);
    expect(prunableDirs(['A/B/', 'X/'], [null, 'Y/n.md'])).toEqual(['A/B/', 'A/', 'X/']);
    expect(prunableDirs(['A/'], ['A/B/n.md'])).toEqual([]);
  });
});
