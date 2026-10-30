// What a load READS of a map's folder tree: everything, except the insides of folded sections, which
// are only counted (store/tree.ts planTree).
import { describe, expect, it } from 'vitest';
import { planTree } from '../src/store/tree.js';

const PATHS = ['Loose.md', 'board.json', 'attachments/pic.png',
  'Ideas/_index.md', 'Ideas/A.md', 'Ideas/Deep/_index.md', 'Ideas/Deep/B.md',
  'Todo/_index.md', 'Todo/Milk.md', 'Bare/Note.md'];

describe('planTree', () => {
  it('reads everything when nothing is folded, and knows a folder with no notes is not a section', () => {
    const p = planTree(PATHS, '', () => false);
    expect(p.read).toEqual(PATHS.filter(x => x.endsWith('.md')));
    expect(p.lazy.size).toBe(0);
    expect([...p.foreign]).toEqual(['attachments/']);
  });
  it('reads only the section note of a folded folder, and counts the rest', () => {
    const p = planTree(PATHS, '', d => d === 'Ideas/');
    expect(p.read).toContain('Ideas/_index.md');
    expect(p.read).not.toContain('Ideas/A.md');
    expect(p.read).not.toContain('Ideas/Deep/B.md');
    expect(p.lazy.get('Ideas/')).toEqual({ count: 3, hasIndex: true, sections: 1 });   // Deep/ is one of them
    expect(p.lazy.has('Ideas/Deep/')).toBe(false);   // never asked: nothing under a folded folder is
  });
  it('folds a folder with no section note too', () => {
    const p = planTree(PATHS, '', (_d, hasIndex) => !hasIndex);
    expect(p.lazy.get('Bare/')).toEqual({ count: 1, hasIndex: false, sections: 0 });
    expect(p.read).not.toContain('Bare/Note.md');
  });
  it('plans one folder at a time', () => {
    const p = planTree(PATHS.filter(x => x.startsWith('Ideas/')), 'Ideas/', d => d === 'Ideas/Deep/');
    expect(p.read).toEqual(['Ideas/_index.md', 'Ideas/A.md', 'Ideas/Deep/_index.md']);
    expect(p.lazy.get('Ideas/Deep/')).toEqual({ count: 1, hasIndex: true, sections: 0 });
  });
});
