// ---------- recently-used custom colours ----------
// The palette's 11 keys are fixed, but a custom colour (`color: "#ff8800"` — see main.ts's
// colorClass/colorVars) is picked from the OS colour sheet and would otherwise be unrepeatable: no
// chip to click a second time, and no way to give a sibling card the shade you chose a minute ago.
//
// Two sources, exactly like the emoji tag picker's recents (features/emoji-picker.ts, the same
// problem one axis over):
//   the MRU — what you last picked, in localStorage. A UI convenience, NOT vault data: no
//     frontmatter key, no map-level palette to invent, nothing written to a note.
//   the MAP — every distinct custom colour already in use in the open map, derived fresh.
// The second is what saves the first from being useless: a device that has never picked a colour
// (a fresh browser, the same map opened on the iPad, a vault imported from a .zip) has an empty
// MRU while the map itself is full of custom colours. Deriving from `state.nodes` also self-prunes —
// recolour the last card away from a shade and it stops being offered, without a cache to invalidate.
import { state } from '../core/state.js';
import { isHexColor } from '../utils/ink.js';

const MRU_KEY = 'corkboard.colorMru';
const MRU_MAX = 8;    // what's remembered
const SHOWN_MAX = 6;  // what fits on the row (see .swatches in styles.css)

// Everything compares and de-duplicates on this form. The native input always yields lowercase
// `#rrggbb`, but a hand-authored or imported note can carry `#FFF` or `#FFE9A8` — without folding
// those together the same colour shows up as two chips.
export function normalizeColor(c: string): string {
  const h = c.trim().toLowerCase();
  if (!isHexColor(h)) return '';
  const d = h.slice(1);
  return d.length === 3 ? `#${d[0]}${d[0]}${d[1]}${d[1]}${d[2]}${d[2]}` : `#${d}`;
}

function loadMru(): string[] {
  try { const raw = JSON.parse(localStorage.getItem(MRU_KEY) ?? '[]'); return Array.isArray(raw) ? raw.filter(c => typeof c === 'string') : []; }
  catch { return []; }
}
// Remember a pick. Called on the picker's COMMIT only (`change`), never per `input` event — the
// native sheet streams a colour for every pointer move, which would bury the real picks under a
// drag's worth of intermediates.
export function rememberColor(color: string): void {
  const c = normalizeColor(color); if (!c) return;
  const mru = [c, ...loadMru().filter(x => x !== c)].slice(0, MRU_MAX);
  try { localStorage.setItem(MRU_KEY, JSON.stringify(mru)); } catch {}
}
// Every distinct custom colour in the open map, in first-seen order.
function mapColors(): string[] {
  const seen = new Set<string>();
  for (const n of state.nodes.values()) {
    const c = normalizeColor(n.color ?? '');
    if (c) seen.add(c);
  }
  return [...seen];
}
// The chips to offer, most-recent first, then whatever else the map uses. Derived on demand (the
// swatch row is rebuilt each time it's shown), so there's nothing to keep in sync with a map load.
export function recentColors(): string[] {
  const out: string[] = [];
  for (const c of [...loadMru(), ...mapColors()])
    if (c && !out.includes(c)) out.push(c);
  return out.slice(0, SHOWN_MAX);
}
