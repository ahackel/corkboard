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
  for (const text of cases) {
    it(`round-trips ${JSON.stringify(text)}`, () => {
      const { title, body, gap } = splitHeading(text);
      expect(joinHeading(title, body, gap)).toBe(text);
    });
  }

  it('only a leading # line is a title', () => {
    expect(splitHeading('- milk').title).toBe('');
    expect(splitHeading('## Sub\n\nx').title).toBe('Sub');
    expect(splitHeading('\n\n# Late\n\nx').title).toBe('Late');
  });
});

describe('parseMd / serializeMd round-trip', () => {
  const files = {
    'titled card':
      '---\ndate: 2026-01-02\n---\n\n# Groceries\n\n- milk\n- eggs\n',
    'untitled card':
      '---\ndate: 2026-01-02\ntags: [home, todo]\ncolor: blue\n---\n\nJust a sticky note.\n',
    'custom hex colour':
      '---\ndate: 2026-01-02\ncolor: "#ff8800"\n---\n\n# Orange\n',
    'tight heading':
      '---\ndate: 2026-01-02\n---\n\n# Title\nNo gap below.\n',
    'foreign frontmatter':
      '---\ndate: 2026-01-02\naliases:\n  - one\n  - two\ncategory: work  # a comment\nstatus: open\n---\n\n# Kept\n\nBody.\n',
    'app-owned flags':
      '---\ndate: 2026-01-02\nmm_locked: true\nmm_type: frame\n---\n\n# Box\n',
    'body with a markdown table and code':
      '---\ndate: 2026-01-02\n---\n\n# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n---\nnot frontmatter\n---\n```\n',
  };
  for (const [name, text] of Object.entries(files)) {
    it(`leaves a ${name} unchanged`, () => {
      expect(serializeMd(nodeFrom(text))).toBe(text);
    });
  }

  it('preserves unknown keys and their order when an app-owned key changes', () => {
    const n = nodeFrom('---\ndate: 2020-05-05\nauthor: Ada\ntags: []\nsource: web\n---\n\n# X\n');
    n.color = 'green'; n.tags = ['a'];
    expect(serializeMd(n)).toBe('---\ndate: 2020-05-05\nauthor: Ada\ntags: [a]\nsource: web\ncolor: green\n---\n\n# X\n');
  });

  it('quotes a custom hex colour (a bare #rrggbb is a YAML comment)', () => {
    const n = nodeFrom('---\ndate: 2026-01-02\n---\n\n# X\n');
    n.color = '#123abc';
    expect(serializeMd(n)).toContain('color: "#123abc"');
    expect(parseMd(serializeMd(n)).color).toBe('#123abc');
  });

  it('reads YAML list-form tags', () => {
    expect(parseMd('---\ntags:\n  - one\n  - "two"\n---\n\nx').tags).toEqual(['one', 'two']);
  });

  it('writes no frontmatter that says nothing: no date stamp, no empty tags, no empty block', () => {
    expect(serializeMd(nodeFrom('# New\n\nText'))).toBe('# New\n\nText\n');
    expect(serializeMd(nodeFrom('---\ndate: 1999-01-01\n---\n\n# Old'))).toBe('---\ndate: 1999-01-01\n---\n\n# Old\n');
    const tagged = nodeFrom('---\ntags: [a]\n---\n\n# Was tagged');
    tagged.tags = [];
    expect(serializeMd(tagged)).toBe('# Was tagged\n');
  });

  it('keeps an empty block when the text opens on a `---` line, so it is not read as one', () => {
    const n = nodeFrom('x');
    n.body = '---\n\nAfter a rule';
    const out = serializeMd(n);
    expect(out).toBe('---\n\n---\n\n---\n\nAfter a rule\n');
    expect(parseMd(out).body).toBe('---\n\nAfter a rule');
    expect(serializeMd(nodeFrom(out))).toBe(out);
  });

  it('drops legacy geometry keys (board.json owns them now)', () => {
    const out = serializeMd(nodeFrom('---\ndate: 2026-01-02\nmm_x: 10\nmm_position_y: 4\nmm_w: 300\nmm_collapsed: true\n---\n\n# X\n'));
    expect(out).not.toMatch(/mm_x|mm_position|mm_w|mm_collapsed/);
  });

  it('never writes the parent — the folder says it — and drops an old mm_parent', () => {
    const parent = nodeFrom('# Parent', 'dir/_index.md', 'p');
    const child = nodeFrom('---\nmm_parent: Parent.md\n---\n\n# Child', 'dir/Child.md', 'c');
    child.parent = parent.id;
    expect(serializeMd(child)).not.toContain('mm_parent');
  });

  it('marks a note that was emptied on purpose', () => {
    const n = nodeFrom('---\ndate: 2026-01-02\n---\n\n# Gone\n');
    n.title = ''; n.body = '';
    const out = serializeMd(n);
    expect(out).toContain('mm_blank: true');
    expect(parseMd(out).mm.blank).toBe(true);
  });

  it('opens every retired kind as a plain card or section', () => {
    expect(parseMd('---\nmm_type: image\n---\nx').mm.type).toBe('card');
    expect(parseMd('---\nmm_layout: stack\n---\nx').mm).toMatchObject({ type: 'card', wasStack: true });
    expect(parseMd('---\nmm_layout: frame-v\n---\nx').mm.type).toBe('section');
    expect(parseMd('---\nmm_type: annotation\nmm_parent: Card.md\n---\n\nremark').mm).toMatchObject({ type: 'card', parent: 'Card.md' });
    expect(parseMd('---\nmm_type: frame\nmm_layout: tabs\n---\n\n# Group').mm.type).toBe('section');
  });

  it('drops the cut arrangement and checklist keys on the next write', () => {
    const n = nodeFrom('---\ndate: 2026-01-02\nmm_checklist: true\nmm_done: true\nmm_type: frame\nmm_layout: horizontal\n---\n\n# Box\n');
    expect(n.type).toBe('section');
    expect(serializeMd(n)).toBe('---\ndate: 2026-01-02\nmm_type: frame\n---\n\n# Box\n');
  });

  it('opens a retired query card as a plain card, keeping its title and body', () => {
    const n = nodeFrom('---\ndate: 2026-01-02\nmm_type: query\nmm_query: p:Ideas\nmm_w: 280\nmm_h: 320\n---\n\n# Find ideas\n\nnotes\n');
    expect(n.type).toBe('card');
    expect(serializeMd(n)).toBe('---\ndate: 2026-01-02\n---\n\n# Find ideas\n\nnotes\n');
  });

  it('reads frontmatter from a file with Windows line endings', () => {
    const p = parseMd('---\r\ndate: 2026-01-02\r\ntags: [a]\r\n---\r\n\r\n# Title\r\n\r\nBody\r\n');
    expect(p.title).toBe('Title');
    expect(p.tags).toEqual(['a']);
    expect(p.body).toBe('Body');
  });
});

describe('frontmatter the app does not own survives a save', () => {
  const roundTrip = (text: string, edit: (n: ReturnType<typeof nodeFrom>) => void = () => {}): string => {
    const n = nodeFrom(text);
    edit(n);
    return serializeMd(n);
  };

  it('keeps keys with spaces, quotes or letters outside ASCII, even under a key the app rewrites', () => {
    const text = '---\ntags: [a]\ndate created: 2026-01-02\n"my key": 1\nÜberschrift: ja\ncolor: blue\n---\n\nBody\n';
    const out = roundTrip(text, n => { n.tags = ['a', 'b']; n.color = 'red'; });
    expect(out).toContain('date created: 2026-01-02');
    expect(out).toContain('"my key": 1');
    expect(out).toContain('Überschrift: ja');
    expect(out).toContain('tags: [a, b]');
    expect(out).toContain('color: red');
  });

  it('keeps a comment that follows a key the app rewrites', () => {
    const out = roundTrip('---\ntags: [a]\n# keep me\nother: 1\n---\n\nBody\n', n => { n.tags = ['b']; });
    expect(out).toBe('---\ntags: [b]\n# keep me\nother: 1\n---\n\nBody\n');
  });

  it('reads a tag list with a comment after it, and writes the comment back', () => {
    const text = '---\ntags: [a, b] # x\n---\n\nBody\n';
    expect(parseMd(text).tags).toEqual(['a', 'b']);
    expect(roundTrip(text)).toBe(text);
  });

  it('keeps a quoted tag whole', () => {
    const text = '---\ntags: ["a, b", c]\n---\n\nBody\n';
    expect(parseMd(text).tags).toEqual(['a, b', 'c']);
    expect(roundTrip(text)).toBe(text);
  });

  it('reads a list written under the key, blank line and all, and a bare `#tag`', () => {
    expect(parseMd('---\ntags:\n  - a\n\n  - b\nother: 1\n---\nx').tags).toEqual(['a', 'b']);
    expect(parseMd('---\ntags: #idea\n---\nx').tags).toEqual(['idea']);
    expect(parseMd('---\ntags: idea # why\n---\nx').tags).toEqual(['idea']);
  });

  it('writes a title back with the heading level it was read with', () => {
    expect(roundTrip('## Sub\n\nBody\n')).toBe('## Sub\n\nBody\n');
    expect(roundTrip('### Deep\nBody\n')).toBe('### Deep\nBody\n');
    expect(roundTrip('# Top\n\nBody\n')).toBe('# Top\n\nBody\n');
  });
});

