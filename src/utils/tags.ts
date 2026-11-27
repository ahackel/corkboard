// A TAG is an OBSIDIAN tag: the frontmatter `tags:` list (the app's to change) plus `#word` in the text
// (read only). Not numbers alone; matching ignores case, and a parent matches its nested tags.

// A letter or number, a combining mark, `_ - /`, or a piece of an emoji (selector, joiner, skin tone, flag, keycap).
export const TAG_CH = String.raw`[\p{L}\p{N}\p{M}_\-\/\p{Extended_Pictographic}‍️⃣\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]`;

// eslint-disable-next-line no-misleading-character-class -- each is matched ONE BY ONE on purpose
const NOT_CH = new RegExp(`(?!${TAG_CH}).`, 'gsu');

// After a line start, a space or an opening bracket, so `page#part`, `&#39;` and `# ` are not tags.
// eslint-disable-next-line no-misleading-character-class -- each is matched ONE BY ONE on purpose
export const INLINE_TAG = new RegExp(`(^|[\\s(\\[{,;])#(${TAG_CH}+)`, 'gu');

// A tag being TYPED: it ends at the caret.
// eslint-disable-next-line no-misleading-character-class -- each is matched ONE BY ONE on purpose
export const TYPING_TAG = new RegExp(`(?:^|[\\s(\\[{,;])#(${TAG_CH}+)$`, 'u');

const isValidTag = (t: string): boolean => !!t && !/^[\d/]+$/.test(t);

// Spaces become `-` and what a tag can't hold is dropped; '' when nothing usable is left.
export function cleanTag(raw: string): string {
  const t = raw.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(NOT_CH, '').replace(/^\/+|\/+$/g, '');
  return isValidTag(t) ? t : '';
}

// Code (fenced blocks and inline spans) is not text.
export function textTags(md: string): string[] {
  const out: string[] = [];
  let fence = '';
  for (const line of md.split('\n')) {
    const f = line.match(/^(```|~~~)/);
    if (f) { fence = fence ? (line.startsWith(fence) ? '' : fence) : f[1]; continue; }
    if (fence || !line.includes('#')) {
      continue;
    }
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(INLINE_TAG)) {
      const t = m[2].replace(/\/+$/, '');
      if (isValidTag(t)) {
        out.push(t);
      }
    }
  }
  return uniqueTags(out);
}

// Ignores case; keeps the first spelling.
export function uniqueTags(tags: Iterable<string>): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const t of tags) { const k = tagKey(t); if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}

export const tagKey = (t: string): string => t.toLowerCase();

// Matches the tag itself or one nested under it.
export function hasTag(tags: readonly string[], want: string): boolean {
  const w = tagKey(want);
  return tags.some(t => { const k = tagKey(t); return k === w || k.startsWith(w + '/'); });
}

// No letter or number, and a pictograph. A letter DRAWN as an emoji (ℹ️, the keycap 1️⃣) counts as a pictograph.
const DRAWN_AS_EMOJI = /[\p{L}\p{N}]\uFE0F\u20E3?/gu;

export function isEmojiTag(t: string): boolean {
  const rest = t.replace(DRAWN_AS_EMOJI, '');
  return !/[\p{L}\p{N}]/u.test(rest) && (rest !== t || /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u.test(t));
}

// Derived from the tag, so it always sits the same way and nothing is stored.
const TILTS = [-8, -5, -3, 3, 5, 7];

export function tagTilt(t: string): number {
  let h = 0;
  for (const c of t) {
    h = (h * 31 + c.codePointAt(0)!) | 0;
  }
  return TILTS[Math.abs(h) % TILTS.length];
}

// Frontmatter tags, then text tags it doesn't already have. Cached per note: paintNode asks every paint.
export interface ShownTag { tag: string; inText: boolean; }
interface Tagged { tags: string[]; title: string; body: string; }
const fromText = new WeakMap<Tagged, { src: string; tags: string[] }>();

export function noteTags(n: Tagged): ShownTag[] {
  const src = n.title + '\n' + n.body;
  let c = fromText.get(n);
  if (!c || c.src !== src) {
    fromText.set(n, c = { src, tags: src.includes('#') ? textTags(src) : [] });
  }
  const own = new Set(n.tags.map(tagKey));
  return [...n.tags.map(tag => ({ tag, inText: false })),
    ...c.tags.filter(t => !own.has(tagKey(t))).map(tag => ({ tag, inText: true }))];
}

// Sections wear no tags.
export const wearsTags = (n: { type: string } | undefined): boolean => !!n && n.type !== 'section';

export const allTags = (n: Tagged): string[] => noteTags(n).map(t => t.tag);
