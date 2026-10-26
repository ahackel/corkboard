// The file format: a note must survive load → save unchanged, and a save may rewrite ONLY the
// app-owned keys (tags, color, mm_*). These are the guarantees that keep a user's vault safe.
import { beforeEach, describe, expect, it } from 'vitest';
import { parseMd, serializeMd, splitHeading, joinHeading } from '../src/utils/frontmatter.js';
import { state } from '../src/core/state.js';
import { nodeFrom } from './helpers.js';

beforeEach(() => state.nodes.clear());

describe('splitHeading / joinHeading', () => {
  const cases = [
    '# Title\n\nBody text',
    '# Title\nTight body',
    '# Title',
    'Just a body, no title',
    '- milk\n- eggs',
    '',
  ];
  for (const text of cases)
    it(`round-trips ${JSON.stringify(text)}`, () => {
      const { title, body, gap } = splitHeading(text);
      expect(joinHeading(title, body, gap)).toBe(text);
    });

  it('only a leading # line is a title', () => {
    expect(splitHeading('- milk').title).toBe('');
    expect(splitHeading('## Sub\n\nx').title).toBe('Sub');
    expect(splitHeading('\n\n# Late\n\nx').title).toBe('Late');
  });
});

describe('parseMd / serializeMd round-trip', () => {
  const files = {
    'titled card':
      '---\ndate: 2026-01-02\ntags: []\n---\n\n# Groceries\n\n- milk\n- eggs\n',
    'untitled card':
      '---\ndate: 2026-01-02\ntags: [home, todo]\ncolor: blue\n---\n\nJust a sticky note.\n',
    'custom hex colour':
      '---\ndate: 2026-01-02\ntags: []\ncolor: "#ff8800"\n---\n\n# Orange\n',
    'tight heading':
      '---\ndate: 2026-01-02\ntags: []\n---\n\n# Title\nNo gap below.\n',
    'foreign frontmatter':
      '---\ndate: 2026-01-02\naliases:\n  - one\n  - two\ncategory: work  # a comment\ntags: []\nstatus: open\n---\n\n# Kept\n\nBody.\n',
    'app-owned flags':
      '---\ndate: 2026-01-02\ntags: []\nmm_checklist: true\nmm_type: frame\nmm_layout: horizontal\n---\n\n# Box\n',
    'body with a markdown table and code':
      '---\ndate: 2026-01-02\ntags: []\n---\n\n# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n---\nnot frontmatter\n---\n```\n',
  };
  for (const [name, text] of Object.entries(files))
    it(`leaves a ${name} unchanged`, () => {
      expect(serializeMd(nodeFrom(text))).toBe(text);
    });

  it('preserves unknown keys and their order when an app-owned key changes', () => {
    const n = nodeFrom('---\ndate: 2020-05-05\nauthor: Ada\ntags: []\nsource: web\n---\n\n# X\n');
    n.color = 'green'; n.tags = ['a'];
    expect(serializeMd(n)).toBe('---\ndate: 2020-05-05\nauthor: Ada\ntags: [a]\nsource: web\ncolor: green\n---\n\n# X\n');
  });

  it('quotes a custom hex colour (a bare #rrggbb is a YAML comment)', () => {
    const n = nodeFrom('---\ndate: 2026-01-02\ntags: []\n---\n\n# X\n');
    n.color = '#123abc';
    expect(serializeMd(n)).toContain('color: "#123abc"');
    expect(parseMd(serializeMd(n)).color).toBe('#123abc');
  });

  it('reads YAML list-form tags', () => {
    expect(parseMd('---\ntags:\n  - one\n  - "two"\n---\n\nx').tags).toEqual(['one', 'two']);
  });

  it('stamps a date only when there is none, never overwriting one', () => {
    expect(serializeMd(nodeFrom('# New'))).toMatch(/^---\ndate: \d{4}-\d{2}-\d{2}\n/);
    expect(serializeMd(nodeFrom('---\ndate: 1999-01-01\n---\n\n# Old'))).toContain('date: 1999-01-01');
  });

  it('drops legacy geometry keys (board.json owns them now)', () => {
    const out = serializeMd(nodeFrom('---\ndate: 2026-01-02\ntags: []\nmm_x: 10\nmm_position_y: 4\nmm_w: 300\nmm_collapsed: true\n---\n\n# X\n'));
    expect(out).not.toMatch(/mm_x|mm_position|mm_w|mm_collapsed/);
  });

  it('writes the parent as its path', () => {
    const parent = nodeFrom('# Parent', 'dir/Parent.md', 'p');
    const child = nodeFrom('# Child', 'dir/Child.md', 'c');
    child.parent = parent.id;
    expect(serializeMd(child)).toContain('mm_parent: dir/Parent.md');
  });

  it('marks a note that was emptied on purpose', () => {
    const n = nodeFrom('---\ndate: 2026-01-02\ntags: []\n---\n\n# Gone\n');
    n.title = ''; n.body = '';
    const out = serializeMd(n);
    expect(out).toContain('mm_blank: true');
    expect(parseMd(out).mm.blank).toBe(true);
  });

  it('folds legacy kinds', () => {
    expect(parseMd('---\nmm_type: image\n---\nx').mm.type).toBe('card');
    expect(parseMd('---\nmm_layout: stack\n---\nx').mm).toMatchObject({ type: 'card', wasStack: true });
    expect(parseMd('---\nmm_layout: frame-v\n---\nx').mm).toMatchObject({ type: 'frame', layout: 'vertical' });
  });

  it('opens a retired query card as a plain card, keeping its title and body', () => {
    const n = nodeFrom('---\ndate: 2026-01-02\ntags: []\nmm_type: query\nmm_query: p:Ideas\nmm_w: 280\nmm_h: 320\n---\n\n# Find ideas\n\nnotes\n');
    expect(n.type).toBe('card');
    expect(serializeMd(n)).toBe('---\ndate: 2026-01-02\ntags: []\n---\n\n# Find ideas\n\nnotes\n');
  });

  it('opens a retired annotation as a plain card', () => {
    expect(parseMd('---\nmm_type: annotation\nmm_parent: Card.md\n---\n\nremark').mm).toMatchObject({ type: 'card', parent: 'Card.md' });
  });

  it('opens a retired tab group as a horizontal frame', () => {
    expect(parseMd('---\nmm_type: frame\nmm_layout: tabs\n---\n\n# Group').mm).toMatchObject({ type: 'frame', layout: 'horizontal' });
  });

  it('reads frontmatter from a file with Windows line endings', () => {
    const p = parseMd('---\r\ndate: 2026-01-02\r\ntags: [a]\r\n---\r\n\r\n# Title\r\n\r\nBody\r\n');
    expect(p.title).toBe('Title');
    expect(p.tags).toEqual(['a']);
    expect(p.body).toBe('Body');
  });
});
