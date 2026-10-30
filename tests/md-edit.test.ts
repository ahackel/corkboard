import { describe, it, expect } from 'vitest';
import { listEnter, listBackspace, indentLines, toggleWrap, taskLines, moveLines, renumbered, pasteTable, sourceOffset,
         tableTab, tableEnter, type TextEdit } from '../src/utils/md-edit.js';
import { renderBodyHTML } from '../src/utils/markdown.js';

// Text with `|` marking the caret (or `[`…`]` a selection), so a case reads as what the editor shows.
function at(s: string): [string, number, number] {
  const c = s.indexOf('|');
  if (c >= 0) {
    return [s.slice(0, c) + s.slice(c + 1), c, c];
  }
  const a = s.indexOf('['), b = s.indexOf(']') - 1;
  return [s.replace('[', '').replace(']', ''), a, b];
}
function show(r: TextEdit | null): string | null {
  if (!r) {
    return null;
  }
  return r.start === r.end ? r.text.slice(0, r.start) + '|' + r.text.slice(r.start)
    : r.text.slice(0, r.start) + '[' + r.text.slice(r.start, r.end) + ']' + r.text.slice(r.end);
}
const enter = (s: string) => show(listEnter(...at(s)));
const tab = (s: string, out = false) => show(indentLines(...at(s), out));
const wrap = (s: string, m: string) => show(toggleWrap(...at(s), m));

describe('listEnter', () => {
  it('continues a bullet, a number and a task', () => {
    expect(enter('- milk|')).toBe('- milk\n- |');
    expect(enter('  * eggs|')).toBe('  * eggs\n  * |');
    expect(enter('9. nine|')).toBe('9. nine\n10. |');
    expect(enter('1) a|')).toBe('1) a\n2) |');
    expect(enter('- [x] done|')).toBe('- [x] done\n- [ ] |');
  });
  it('splits an item at the caret', () => {
    expect(enter('- milk| and eggs')).toBe('- milk\n- | and eggs');
  });
  it('ends the list on an empty item', () => {
    expect(enter('- a\n- |')).toBe('- a\n|');
    expect(enter('- a\n- [ ] |')).toBe('- a\n|');
  });
  it('stands aside off a list, before the marker, or with a selection', () => {
    expect(enter('plain|')).toBeNull();
    expect(enter('# Title|')).toBeNull();
    expect(enter('|- a')).toBeNull();
    expect(enter('- [a]')).toBeNull();
    expect(enter('-no space|')).toBeNull();
  });
});

describe('indentLines', () => {
  it('nests under the item above, by its marker width', () => {
    expect(tab('- a\n- b|')).toBe('- a\n  - b|');
    expect(tab('1. a\n2. b|')).toBe('1. a\n   2. b|');
    expect(tab('plain|')).toBe('  plain|');
  });
  it('un-nests back to the parent level', () => {
    expect(tab('- a\n  - b|', true)).toBe('- a\n- b|');
    expect(tab('1. a\n   - b|', true)).toBe('1. a\n- b|');
    expect(tab('- a|', true)).toBe('- a|');
  });
  it('moves every selected line and keeps the selection on them', () => {
    expect(tab('- a\n[- b\n- c]')).toBe('- a\n  [- b\n  - c]');
    expect(tab('- a\n  [- b\n  - c]', true)).toBe('- a\n[- b\n- c]');
  });
  it('leaves blank lines in a selection blank', () => {
    expect(tab('[- a\n\n- b]')).toBe('  [- a\n\n  - b]');
  });
});

describe('toggleWrap', () => {
  it('wraps a selection, leaving caught whitespace outside', () => {
    expect(wrap('a [bold] b', '**')).toBe('a **[bold]** b');
    expect(wrap('a[ it ]b', '*')).toBe('a *[it]* b');
    expect(wrap('[gone]', '~~')).toBe('~~[gone]~~');
  });
  it('unwraps markers outside or inside the selection', () => {
    expect(wrap('a **[bold]** b', '**')).toBe('a [bold] b');
    expect(wrap('a [**bold**] b', '**')).toBe('a [bold] b');
    expect(wrap('*[it]*', '*')).toBe('[it]');
  });
  it('reads a run of stars whole: italic and bold compose', () => {
    expect(wrap('**[x]**', '*')).toBe('***[x]***');
    expect(wrap('***[x]***', '*')).toBe('**[x]**');
    expect(wrap('***[x]***', '**')).toBe('*[x]*');
  });
  it('gives a caret an empty pair, and takes an empty pair back', () => {
    expect(wrap('a |', '**')).toBe('a **|**');
    expect(wrap('a **|**', '**')).toBe('a |');
  });
});

// Tables are written in pipes, so their cases mark the caret with `^` and a selection with `«…»`.
function tat(s: string): [string, number, number] {
  const c = s.indexOf('^');
  return [s.slice(0, c) + s.slice(c + 1), c, c];
}
function tshow(r: TextEdit | null): string | null {
  if (!r) {
    return null;
  }
  return r.start === r.end ? r.text.slice(0, r.start) + '^' + r.text.slice(r.start)
    : r.text.slice(0, r.start) + '«' + r.text.slice(r.start, r.end) + '»' + r.text.slice(r.end);
}
const ttab = (s: string, back = false) => tshow(tableTab(...tat(s), back));
const tenter = (s: string) => tshow(tableEnter(...tat(s)));

describe('tableTab', () => {
  it('selects the next cell and tidies the table', () => {
    expect(ttab('| a^ | bb |\n|---|:-:|\n| x | y |'))
      .toBe('| a   | «bb»  |\n| --- | :-: |\n| x   | y   |');
  });
  it('steps over the delimiter row, and adds a row past the last cell', () => {
    expect(ttab('| a | bb^ |\n|---|:-:|\n| x | y |')).toBe('| a   | bb  |\n| --- | :-: |\n| «x»   | y   |');
    expect(ttab('| a | bb |\n|---|:-:|\n| x | y ^|')).toBe('| a   | bb  |\n| --- | :-: |\n| x   | y   |\n| ^    |     |');
  });
  it('goes back a cell with ⇧Tab, and stays put at the first', () => {
    expect(ttab('| a | bb |\n|---|:-:|\n| x | y^ |', true)).toBe('| a   | bb  |\n| --- | :-: |\n| «x»   | y   |');
    expect(ttab('| a | bb |\n|---|:-:|\n| x^ | y |', true)).toBe('| a   | «bb»  |\n| --- | :-: |\n| x   | y   |');
    expect(ttab('| a^ | bb |\n|---|:-:|', true)).toBe('| «a»   | bb  |\n| --- | :-: |');
  });
  it('keeps alignment, escaped pipes, and pads wide characters by their width', () => {
    expect(ttab('| a | b | c |\n|:--|--:|:-:|\n| 1^ | 2 | 3 |'))
      .toBe('| a   | b   | c   |\n| :-- | --: | :-: |\n| 1   | «2»   | 3   |');
    expect(ttab('| a\\|b^ | c |\n|---|---|')).toBe('| a\\|b | «c»   |\n| ---- | --- |');
    expect(ttab('| 日本^ | c |\n|---|---|')).toBe('| 日本 | «c»   |\n| ---- | --- |');
  });
  it('stands aside off a table, so Tab can indent', () => {
    expect(ttab('a | b^')).toBeNull();
    expect(ttab('| a | b |\nno delimiter^')).toBeNull();
    expect(ttab('| a | b |\n|---|---|\n\nafter^')).toBeNull();
  });
});

describe('tableEnter', () => {
  it('adds a row under the caret, in the same column', () => {
    expect(tenter('| a | b |\n|---|---|\n| x | y^ |'))
      .toBe('| a   | b   |\n| --- | --- |\n| x   | y   |\n|     | ^    |');
    expect(tenter('| a^ | b |\n|---|---|\n| x | y |'))
      .toBe('| a   | b   |\n| --- | --- |\n| ^    |     |\n| x   | y   |');
  });
  it('ends the table on an empty last row', () => {
    expect(tenter('| a | b |\n|---|---|\n| x | y |\n| ^ |  |\nafter'))
      .toBe('| a   | b   |\n| --- | --- |\n| x   | y   |\n^\nafter');
  });
  it('starts a table from a lone header row', () => {
    expect(tenter('# T\n| Name | Age |^')).toBe('# T\n| Name | Age |\n| ---- | --- |\n| ^     |     |');
    expect(tenter('| one |^')).toBeNull();
    expect(tenter('| a | b^ |')).toBeNull();
    expect(tenter('plain^')).toBeNull();
  });
});

describe('renderBodyHTML lists', () => {
  it('nests by indentation', () => {
    expect(renderBodyHTML('- a\n  - b\n  - c\n- d'))
      .toBe('<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>');
  });
  it('nests a bullet under a number and switches kind at one level', () => {
    expect(renderBodyHTML('1. a\n   - b\n2. c'))
      .toBe('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>');
    expect(renderBodyHTML('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });
  it('closes several levels at once', () => {
    expect(renderBodyHTML('- a\n  - b\n    - c\n- d'))
      .toBe('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  });
  it('numbers tasks in body order through nesting, for write-back', () => {
    const h = renderBodyHTML('- [ ] a\n  - [x] b\n- [ ] c');
    expect([...h.matchAll(/data-ti="(\d)"( checked)?/g)].map(m => m[1] + (m[2] ? 'x' : ''))).toEqual(['0', '1x', '2']);
    expect(h).toContain('<span class="task-text">a</span><ul>');
  });
});

const bs = (s: string) => show(renumbered(listBackspace(...at(s))));
const move = (s: string, up: boolean) => show(renumbered(moveLines(...at(s), up)));
const task = (s: string) => show(taskLines(...at(s)));
const enterN = (s: string) => show(renumbered(listEnter(...at(s))));
const tabN = (s: string, out = false) => show(renumbered(indentLines(...at(s), out)));

describe('listBackspace', () => {
  it('takes a top-level marker, keeping the text', () => {
    expect(bs('- |')).toBe('|');
    expect(bs('a\n- [ ] |milk')).toBe('a\n|milk');
  });
  it('steps a nested item out first', () => {
    expect(bs('- a\n  - |b')).toBe('- a\n- |b');
  });
  it('renumbers what follows', () => {
    expect(bs('1. a\n2. |b\n3. c\n4. d')).toBe('1. a\n|b\n3. c\n4. d');
    expect(bs('1. a\n2. |\n2. b')).toBe('1. a\n|\n2. b');
  });
  it('stands aside anywhere else', () => {
    expect(bs('- a|')).toBeNull();
    expect(bs('-| a')).toBeNull();
    expect(bs('plain|')).toBeNull();
    expect(bs('- [a]')).toBeNull();
  });
});

describe('moveLines', () => {
  it('swaps a line with its neighbour, caret riding along', () => {
    expect(move('a\nb|\nc', true)).toBe('b|\na\nc');
    expect(move('a|\nb\nc', false)).toBe('b\na|\nc');
    expect(move('a|\nb', true)).toBeNull();
    expect(move('a\nb|', false)).toBeNull();
  });
  it('carries an item\'s children and hops a whole neighbouring item', () => {
    expect(move('- a\n  - a1\n- b|\n  - b1', true)).toBe('- b|\n  - b1\n- a\n  - a1');
    expect(move('- a|\n  - a1\n- b\n  - b1', false)).toBe('- b\n  - b1\n- a|\n  - a1');
  });
  it('moves a selection of lines, and renumbers', () => {
    expect(move('1. a\n2. b\n[3. c]', true)).toBe('1. a\n[2. c]\n3. b');
  });
});

describe('taskLines', () => {
  it('turns a line or a bullet into a task, and a task into done and back', () => {
    expect(task('milk|')).toBe('- [ ] milk|');
    expect(task('  - milk|')).toBe('  - [ ] milk|');
    expect(task('3. milk|')).toBe('- [ ] milk|');
    expect(task('- [ ] milk|')).toBe('- [x] milk|');
    expect(task('- [x] milk|')).toBe('- [ ] milk|');
    expect(task('|')).toBe('- [ ] |');
  });
  // a selection over task boxes is marked «…», since the boxes are written in brackets
  const taskSel = (s: string) => {
    const a = s.indexOf('«'), b = s.indexOf('»') - 1;
    return tshow(taskLines(s.replace('«', '').replace('»', ''), a, b));
  };
  it('treats a selection as one: mixed → all tasks, open → all done, done → all open', () => {
    expect(taskSel('«- [x] a\nb»')).toBe('«- [x] a\n- [ ] b»');
    expect(taskSel('«- [x] a\n- [ ] b»')).toBe('«- [x] a\n- [x] b»');
    expect(taskSel('«- [x] a\n- [x] b»')).toBe('«- [ ] a\n- [ ] b»');
  });
  it('leaves headings and blank lines alone', () => {
    expect(taskSel('«# T\n\na»')).toBe('«# T\n\n- [ ] a»');
  });
});

describe('renumber', () => {
  it('counts on after Enter mid-list', () => {
    expect(enterN('1. a|\n2. b')).toBe('1. a\n2. |\n3. b');
    expect(enterN('9. a|\n10. b')).toBe('9. a\n10. |\n11. b');
  });
  it('restarts a nested list at 1 and closes the gap above it', () => {
    expect(tabN('1. a\n2. b|\n3. c')).toBe('1. a\n   1. b|\n2. c');
    expect(tabN('1. a\n   1. b|\n2. c', true)).toBe('1. a\n2. b|\n3. c');
  });
  it('keeps a top-level start, and leaves a list beyond a blank line alone', () => {
    expect(enterN('5. a|\n\n1. x\n1. y')).toBe('5. a\n6. |\n\n1. x\n1. y');
  });
});

describe('pasteTable', () => {
  const paste = (s: string, clip: string) => show(pasteTable(...at(s), clip));
  it('turns spreadsheet rows into a tidied table, on lines of its own', () => {
    expect(paste('see |', 'Name\tAge\nAda\t36\n'))
      .toBe('see \n| Name | Age |\n| ---- | --- |\n| Ada  | 36  ||');
  });
  it('reads quoted cells and escapes pipes', () => {
    expect(paste('|', 'a\tb\n"x\ny"\t"say ""hi"""\nc|d\te'))
      .toBe('| a    | b        |\n| ---- | -------- |\n| x y  | say "hi" |\n| c\\|d | e        ||');
  });
  it('stands aside for one row, one column, or ragged rows', () => {
    expect(pasteTable('', 0, 0, 'a\tb')).toBeNull();
    expect(pasteTable('', 0, 0, 'a\nb')).toBeNull();
    expect(pasteTable('', 0, 0, 'a\tb\nc')).toBeNull();
  });
});

describe('sourceOffset', () => {
  const src = '# T\n\nSome **bold** text and a [link](http://x.y)\n- item one';
  const from = 3;
  const texts = ['Some ', 'bold', ' text and a ', 'link', 'item one'];
  it('maps a rendered text node and offset back into the source', () => {
    expect(src.slice(sourceOffset(src, from, texts, 1, 2)!)).toMatch(/^ld\*\*/);
    expect(src.slice(sourceOffset(src, from, texts, 3, 0)!)).toMatch(/^link\]/);
    expect(src.slice(sourceOffset(src, from, texts, 4, 5)!)).toBe('one');
  });
  it('lets whitespace differ, as a soft line break does', () => {
    const s = 'one\ntwo three';
    expect(s.slice(sourceOffset(s, 0, ['one two three'], 0, 8)!)).toBe('three');
  });
  it('is null when the text is not in the source', () => {
    expect(sourceOffset('abc', 0, ['zzz'], 0, 1)).toBeNull();
  });
});
