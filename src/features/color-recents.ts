// Recently-used custom colours: what you last picked (localStorage, not vault data), then every
// custom colour the open map already uses, so a fresh device still has something to offer.
import { state } from '../core/state.js';
import { normalizeColor } from '../utils/ink.js';
import { readStrings, pushRecent } from '../utils/local-json.js';

const MRU_KEY = 'corkboard.colorMru';
const MRU_MAX = 8;

// What fits on the row (.swatches in styles.css).
const SHOWN_MAX = 6;

const loadMru = (): string[] => readStrings(MRU_KEY);

// Call on the picker's `change` only: `input` streams a colour for every pointer move.
export function rememberColor(color: string): void {
  const c = normalizeColor(color);
  if (c) {
    pushRecent(MRU_KEY, c, MRU_MAX);
  }
}

function mapColors(): string[] {
  const seen = new Set<string>();
  for (const n of state.nodes.values()) {
    const c = normalizeColor(n.color ?? '');
    if (c) {
      seen.add(c);
    }
  }
  return [...seen];
}

export function recentColors(): string[] {
  const out: string[] = [];
  // Another page of this origin can write localStorage, so its colours are normalized too.
  for (const c of [...loadMru().map(normalizeColor), ...mapColors()]) {
    if (c && !out.includes(c)) {
      out.push(c);
    }
  }
  return out.slice(0, SHOWN_MAX);
}
