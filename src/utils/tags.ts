// A TAG is an OBSIDIAN tag — any word, and an emoji is simply the shortest one. Pure, pinned by
// tests/tags.test.ts. A note carries tags two ways, both Obsidian's:
//   · its frontmatter `tags:` list — MindNode.tags, the ones the app adds and removes (`#`);
//   · `#word` written in the text — read, shown and filtered on, never moved or rewritten.
// Obsidian's rules: no spaces; letters, numbers, `_`, `-` and `/` (a NESTED tag, `project/alpha`), plus
// emoji; not numbers alone (`#1` is an issue number, not a tag). Matching ignores case, and a parent
// matches its nested tags.

// One character a tag may hold: a letter or number (any script), a combining mark, `_ - /`, or a piece of
// an emoji — the pictograph, its variation selector and joiner, skin tones, flag letters and the keycap.
const CH = String.raw`[\p{L}\p{N}\p{M}_\-\/\p{Extended_Pictographic}‍️⃣\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]`;
// eslint-disable-next-line no-misleading-character-class -- the joiner, selectors and marks are matched ONE BY ONE, on purpose
const NOT_CH = new RegExp(`(?!${CH}).`, 'gsu');
// `#tag` in running text: at the start of a line or after a space or an opening bracket, so a URL's
// `page#part`, an HTML entity's `&#39;` and a heading's `# ` are not tags.
// eslint-disable-next-line no-misleading-character-class -- the joiner, selectors and marks are matched ONE BY ONE, on purpose
export const INLINE_TAG = new RegExp(`(^|[\\s(\\[{,;])#(${CH}+)`, 'gu');

const valid = (t: string): boolean => !!t && !/^[\d/]+$/.test(t);

// What a person typed (or a file held) as a tag, made into one: no `#`, spaces become `-`, anything
// a tag can't hold dropped. '' when nothing usable is left.
export function cleanTag(raw: string): string {
  const t = raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(NOT_CH, '').replace(/^\/+|\/+$/g, '');
  return valid(t) ? t : '';
}

// The `#tags` written in a note's text. Code — fenced blocks and `inline spans` — is not text.
export function textTags(md: string): string[] {
  const out: string[] = [];
  let fence = '';
  for (const line of md.split('\n')) {
    const f = line.match(/^(```|~~~)/);
    if (f) { fence = fence ? (line.startsWith(fence) ? '' : fence) : f[1]; continue; }
    if (fence || !line.includes('#')) continue;
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(INLINE_TAG)) {
      const t = m[2].replace(/\/+$/, '');
      if (valid(t)) out.push(t);
    }
  }
  return uniqueTags(out);
}

// Dedupe ignoring case, the first spelling kept.
export function uniqueTags(tags: Iterable<string>): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const t of tags) { const k = tagKey(t); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}
export const tagKey = (t: string): string => t.toLowerCase();

// Does a note carrying `tags` match `want`? Itself, ignoring case, or a tag nested under it.
export function hasTag(tags: readonly string[], want: string): boolean {
  const w = tagKey(want);
  return tags.some(t => { const k = tagKey(t); return k === w || k.startsWith(w + '/'); });
}

// An EMOJI tag is drawn as a stamp, a word tag as a label: no letter or number in it, and a pictograph.
export function isEmojiTag(t: string): boolean {
  return !/[\p{L}\p{N}]/u.test(t) && /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(t);
}

// The small tilt a tag is stuck on at — derived from the tag, so the same tag always sits the same way
// and nothing about it is stored.
const TILTS = [-8, -5, -3, 3, 5, 7];
export function tagTilt(t: string): number {
  let h = 0;
  for (const c of t) h = (h * 31 + c.codePointAt(0)!) | 0;
  return TILTS[Math.abs(h) % TILTS.length];
}

// Every tag a note carries, as the card shows them: its frontmatter tags, then the ones written in its
// text that the frontmatter doesn't already have (`inText` — those are the note's to change, not ours).
// Cached per note on the text it was read from: paintNode asks for every card on every paint.
export interface ShownTag { tag: string; inText: boolean; }
interface Tagged { tags: string[]; title: string; body: string; }
const fromText = new WeakMap<Tagged, { src: string; tags: string[] }>();
export function noteTags(n: Tagged): ShownTag[] {
  const src = n.title + '\n' + n.body;
  let c = fromText.get(n);
  if (!c || c.src !== src) fromText.set(n, c = { src, tags: src.includes('#') ? textTags(src) : [] });
  const own = new Set(n.tags.map(tagKey));
  return [...n.tags.map(tag => ({ tag, inText: false })),
    ...c.tags.filter(t => !own.has(tagKey(t))).map(tag => ({ tag, inText: true }))];
}
// A FRAME wears no tags — they go on cards. The one test every tag surface asks.
export const wearsTags = (n: { type: string } | undefined): boolean => !!n && n.type !== 'frame';
// …and the bare names, for matching.
export const allTags = (n: Tagged): string[] => noteTags(n).map(t => t.tag);
