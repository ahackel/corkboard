// Tags are Obsidian's (utils/tags.ts): what counts as one, in a note's text and as typed, and how they
// match. Plus emoji by name for the `#` field (utils/emoji-names.ts) and how a `#tag` renders.
import { describe, expect, it } from 'vitest';
import { cleanTag, textTags, hasTag, isEmojiTag, noteTags } from '../src/utils/tags.js';
import { emojiByName } from '../src/utils/emoji-names.js';
import { renderBodyHTML } from '../src/utils/markdown.js';
import { parseMd } from '../src/utils/frontmatter.js';

describe('textTags', () => {
  it('reads #tags from running text, the way Obsidian does', () => {
    expect(textTags('Try #idea and #project/alpha.\n#Later')).toEqual(['idea', 'project/alpha', 'Later']);
    expect(textTags('A stamp #🔥 too')).toEqual(['🔥']);
  });
  it('leaves headings, numbers, URLs, entities and code alone', () => {
    expect(textTags('# Heading\n## Sub')).toEqual([]);
    expect(textTags('issue #12 and #2026')).toEqual([]);
    expect(textTags('see https://x.org/page#part and a&#39;b')).toEqual([]);
    expect(textTags('`#notatag` and\n```\n#nor this\n```\n#yes')).toEqual(['yes']);
  });
  it('counts a tag once, whatever its case', () => {
    expect(textTags('#Idea #idea #IDEA')).toEqual(['Idea']);
  });
});

describe('cleanTag', () => {
  it('turns what was typed into a tag', () => {
    expect(cleanTag('#idea')).toBe('idea');
    expect(cleanTag('  big plan ')).toBe('big-plan');
    expect(cleanTag('🔥')).toBe('🔥');
    expect(cleanTag('a,b!')).toBe('ab');
    expect(cleanTag('project/alpha/')).toBe('project/alpha');
  });
  it('refuses what cannot be one', () => {
    expect(cleanTag('42')).toBe('');
    expect(cleanTag('#')).toBe('');
    expect(cleanTag('!!')).toBe('');
  });
});

describe('matching', () => {
  it('ignores case, and a parent tag matches its nested ones', () => {
    expect(hasTag(['Idea'], 'idea')).toBe(true);
    expect(hasTag(['project/alpha'], 'project')).toBe(true);
    expect(hasTag(['projects'], 'project')).toBe(false);
  });
  it('tells an emoji from a word', () => {
    expect(isEmojiTag('🔥')).toBe(true);
    expect(isEmojiTag('❤️')).toBe(true);
    expect(isEmojiTag('🇩🇪')).toBe(true);
    expect(isEmojiTag('idea')).toBe(false);
    expect(isEmojiTag('v2🔥')).toBe(false);
  });
});

describe('noteTags', () => {
  it('lists the frontmatter tags, then the text’s that the frontmatter lacks', () => {
    const n = { tags: ['🔥', 'Backend'], title: 'Fix #login', body: 'More #backend work, try #idea' };
    expect(noteTags(n)).toEqual([
      { tag: '🔥', inText: false }, { tag: 'Backend', inText: false },
      { tag: 'login', inText: true }, { tag: 'idea', inText: true },
    ]);
  });
});

describe('a tag on disk and on screen', () => {
  it('reads a quoted #tag in the frontmatter as the bare tag', () => {
    expect(parseMd('---\ntags: ["#idea", 🔥]\n---\n\nx').tags).toEqual(['idea', '🔥']);
    expect(parseMd('---\ntags:\n  - "#later"\n---\n\nx').tags).toEqual(['later']);
  });
  it('renders a #tag in the text as one, and nothing else', () => {
    expect(renderBodyHTML('Try #my_idea now')).toContain('<span class="md-tag" data-tag="my_idea">#my_idea</span>');
    expect(renderBodyHTML('issue #12')).not.toContain('md-tag');
    expect(renderBodyHTML('`#code`')).not.toContain('md-tag');
  });
});

describe('emojiByName', () => {
  it('finds an emoji by the start of its name first, then of its other words', () => {
    expect(emojiByName('fi')[0]).toEqual({ emoji: '🔥', name: 'fire' });
    expect(emojiByName('urgent').map(e => e.emoji)).toContain('🔥');
    expect(emojiByName('thumbs')[0].name).toBe('thumbs up');
    expect(emojiByName('')).toEqual([]);
  });
});
