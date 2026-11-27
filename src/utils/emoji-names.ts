// Emoji BY NAME (`fi` offers 🔥 fire): a hand-picked list of tagging emoji first, then every emoji by its
// Unicode name and keywords (utils/emoji-all.ts, generated). A `|` ends a multi-word hand-picked name.
import { ALL_EMOJI } from './emoji-all.js';

const EMOJI: Array<[string, string]> = [
  ['🔥', 'fire hot urgent'], ['⭐', 'star favourite favorite'], ['🌟', 'glowing star|shine'],
  ['📌', 'pin pinned keep'], ['✅', 'check done complete yes'], ['☑️', 'ballot box|checked tick'],
  ['❌', 'cross no cancel wrong'], ['⚠️', 'warning caution risk'], ['❗', 'exclamation important'],
  ['❓', 'question unknown ask'], ['💡', 'idea bulb light'], ['🐛', 'bug defect'], ['🚀', 'rocket launch ship'],
  ['📅', 'calendar date event'], ['🗓️', 'calendar|spiral schedule'], ['⏰', 'alarm clock|deadline'],
  ['⏳', 'hourglass waiting pending'], ['🔒', 'lock locked private'], ['🔑', 'key access'],
  ['👍', 'thumbs up|good agree'], ['👎', 'thumbs down|bad'], ['❤️', 'heart love'], ['🎉', 'party celebrate tada'],
  ['📝', 'memo note write'], ['🔗', 'link chain'], ['🔍', 'search magnifier find research'],
  ['🛠️', 'tools fix build'], ['🚧', 'construction|wip progress'], ['🔔', 'bell notify reminder'],
  ['💬', 'speech|chat talk discuss'], ['🎯', 'target goal focus'], ['📊', 'chart bar data stats'],
  ['📈', 'chart up|growth'], ['🧠', 'brain think'], ['📚', 'books read reading learn'], ['📖', 'open book|read'],
  ['🧩', 'puzzle piece|'], ['💰', 'money bag|finance budget'], ['💸', 'money spend cost'], ['🏆', 'trophy win'],
  ['🚩', 'flag|red issue'], ['🏁', 'finish flag|chequered'], ['🧪', 'test experiment lab'], ['📎', 'paperclip attach'],
  ['🗂️', 'dividers file organise'], ['📁', 'folder'], ['📦', 'package box delivery'], ['🏠', 'home house'],
  ['🏢', 'office work building'], ['💼', 'briefcase work job'], ['👤', 'person user'], ['👥', 'people team group'],
  ['🤝', 'handshake deal meeting'], ['📞', 'phone call'], ['✉️', 'envelope mail email'], ['🛒', 'shopping cart buy'],
  ['✈️', 'airplane travel flight trip'], ['🚗', 'car drive'], ['🍽️', 'food dinner eat'], ['☕', 'coffee break'],
  ['🎵', 'music note song'], ['🎨', 'art palette design'], ['📷', 'camera photo'], ['🎬', 'film movie video'],
  ['🎮', 'game play'], ['🏃', 'run sport exercise'], ['💪', 'strong muscle health'], ['🌱', 'seedling grow new'],
  ['🌍', 'globe world earth'], ['☀️', 'sun weather'], ['🌙', 'moon night'], ['❄️', 'snowflake cold freeze'],
  ['⚡', 'lightning fast energy'], ['💤', 'sleep zzz later someday'], ['🗑️', 'trash delete waste'],
  ['♻️', 'recycle reuse'], ['🔄', 'repeat refresh recurring'], ['➕', 'plus add'], ['➖', 'minus remove'],
  ['🟥', 'red square|'], ['🟧', 'orange square|'], ['🟨', 'yellow square|'], ['🟩', 'green square|'],
  ['🟦', 'blue square|'], ['🟪', 'purple square|'], ['🔴', 'red circle|'], ['🟢', 'green circle|'],
  ['🔵', 'blue circle|'], ['🟡', 'yellow circle|'], ['😀', 'grin happy smile'], ['🙂', 'smile ok'],
  ['😢', 'cry sad'], ['😡', 'angry mad'], ['🤔', 'thinking hmm consider'], ['😴', 'sleepy tired'],
  ['🤯', 'mind blown|wow'], ['👀', 'eyes look review watch'], ['🙏', 'please thanks pray'], ['💯', 'hundred perfect'],
  ['🆕', 'new'], ['🆗', 'ok'], ['🔝', 'top'], ['🧭', 'compass direction plan'], ['🗺️', 'map plan'],
  ['🏗️', 'building construction'], ['🧹', 'broom clean tidy'], ['🎁', 'gift present'], ['📣', 'megaphone announce'],
  ['🧾', 'receipt invoice'], ['📋', 'clipboard list'], ['🗒️', 'notepad notes'], ['🖊️', 'pen write sign'],
  ['💻', 'laptop computer code'], ['📱', 'phone mobile'], ['🤖', 'robot ai bot'], ['🐞', 'lady beetle|bug'],
];

// Accents off (`pinata` finds 🪅) and `-`/`_` as spaces, since a tag can't hold one (`thumbs-up` finds 👍).
const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[-_]+/g, ' ').trim();
const wordsOf = (s: string): string => ' ' + fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');

// `❤` and `❤️` are the same emoji.
const withoutSelector = (e: string): string => e.replace(/\uFE0F/g, '');

interface Entry { emoji: string; name: string; words: string; keys: string }
let hand: Entry[] | null = null, all: Entry[] | null = null;

function lists(): { hand: Entry[]; all: Entry[] } {
  hand ??= EMOJI.map(([emoji, spec]) => {
    const [head, rest = ''] = spec.split('|');
    return { emoji, name: spec.includes('|') ? head : head.split(' ')[0], words: wordsOf(head + ' ' + rest), keys: '' };
  });
  all ??= ALL_EMOJI.split('\n').map(l => l.split('\t'))
    .map(([emoji, name, keys = '']) => ({ emoji, name, words: wordsOf(name), keys: wordsOf(keys) }));
  return { hand, all };
}


// Prefix matches, best first: hand-picked by name then by other word, then exact name, name prefix, later
// word, keyword; each in Unicode order, each emoji once. `byName`: the NAME itself starts with the query.
export interface EmojiHit { emoji: string; name: string; byName: boolean }

export function emojiByName(q: string, max = 6): EmojiHit[] {
  const s = fold(q);
  if (!s) {
    return [];
  }
  const { hand, all } = lists();
  const ranked: Array<{ e: Entry; rank: number }> = [];
  for (const e of hand) {
    const at = e.words.indexOf(' ' + s);
    if (at >= 0) {
      ranked.push({ e, rank: at === 0 ? 0 : 1 });
    }
  }
  for (const e of all) {
    const at = e.words.indexOf(' ' + s);
    if (at >= 0) {
      ranked.push({ e, rank: at > 0 ? 4 : e.words === ' ' + s ? 2 : 3 });
    } else if (e.keys.includes(' ' + s)) {
      ranked.push({ e, rank: 5 });
    }
  }
  const seen = new Set<string>(), out: EmojiHit[] = [];
  for (const { e, rank } of ranked.sort((a, b) => a.rank - b.rank)) {
    if (out.length === max) {
      break;
    }
    if (!seen.has(withoutSelector(e.emoji))) {
      seen.add(withoutSelector(e.emoji));
      out.push({ emoji: e.emoji, name: e.name, byName: rank === 0 || rank === 2 || rank === 3 });
    }
  }
  return out;
}
