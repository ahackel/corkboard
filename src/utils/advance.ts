// The NEXT value of a title, for the smart duplicate (features/crud.ts duplicateNext, ⌘⌥D): the card
// that follows this one in a series. Pure, and pinned by tests/advance.test.ts.
//   · a date `YYYY-MM-DD` steps one day, and a weekday name beside it follows (English or German, full
//     or English three-letter, keeping its case): `2026-10-27 Tuesday` → `2026-10-28 Wednesday`;
//   · otherwise the LAST number counts up, keeping its zero padding: `Sprint 4` → `Sprint 5`,
//     `v1.2` → `v1.3`, `Week 09` → `Week 10`;
//   · anything else stays as it is.
const DAYS = [
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
];

export function advanceTitle(t: string): string {
  const d = /(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (d) {
    const date = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
    // A real date only — `2026-13-45` would quietly normalise to some other day.
    if (date.toISOString().slice(0, 10) === d[0]) {
      date.setUTCDate(date.getUTCDate() + 1);
      const out = t.slice(0, d.index) + date.toISOString().slice(0, 10) + t.slice(d.index + d[0].length);
      return nextWeekday(out, date.getUTCDay());
    }
  }
  const n = /(\d+)(?!.*\d)/.exec(t);
  if (n) {
    return t.slice(0, n.index) + String(+n[1] + 1).padStart(n[1].length, '0') + t.slice(n.index + n[1].length);
  }
  return t;
}

// Replace the first weekday name in `t` with day `day` of the same list, in the same case.
function nextWeekday(t: string, day: number): string {
  for (const names of DAYS) {
    const re = new RegExp(`\\b(${names.join('|')})\\b`, 'i');
    const m = re.exec(t);
    if (!m) {
      continue;
    }
    const name = names[day];
    const cased = m[0] === m[0].toUpperCase() ? name.toUpperCase()
      : m[0] === m[0].toLowerCase() ? name.toLowerCase() : name;
    return t.slice(0, m.index) + cased + t.slice(m.index + m[0].length);
  }
  return t;
}
