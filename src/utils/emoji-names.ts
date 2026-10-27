// Emoji BY NAME, for the `#` field (features/tag-picker.ts): typing `fi` offers 🔥 fire. A short,
// hand-picked list of the emoji people tag with — status, priority, kind of thing, mood — not the whole
// Unicode set; anything else still goes in through the OS emoji picker or a paste. Pure, pinned by
// tests/tags.test.ts. Each entry is the emoji, its name, then a few words it is also found by.
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

// The emoji whose name or words START with what was typed, best first: the name itself before its
// other words. At most `max` of them.
export function emojiByName(q: string, max = 6): Array<{ emoji: string; name: string }> {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const hits: Array<{ emoji: string; name: string; rank: number }> = [];
  for (const [emoji, spec] of EMOJI) {
    const [head, rest = ''] = spec.split('|');
    const name = spec.includes('|') ? head : head.split(' ')[0];
    const words = (head + ' ' + rest).split(/\s+/).filter(Boolean);
    const at = words.findIndex(w => w.startsWith(s));
    if (at >= 0) hits.push({ emoji, name, rank: at === 0 ? 0 : 1 });
  }
  return hits.sort((a, b) => a.rank - b.rank).slice(0, max).map(({ emoji, name }) => ({ emoji, name }));
}
