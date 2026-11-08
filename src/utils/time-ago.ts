// ---------- “5m ago”: how long since a map was last opened (the home screen's list) ----------
export function timeAgo(ts: number, now = Date.now()): string {
  if (!ts) {
    return '';                       // migrated entries carry no last-opened time yet
  }
  const s = (now - ts) / 1000;
  if (s<60) {
    return 'just now';
  }
  if (s<3600) {
    return Math.floor(s/60)+'m ago';
  }
  if (s<86400) {
    return Math.floor(s/3600)+'h ago';
  }
  return Math.floor(s/86400)+'d ago';
}
