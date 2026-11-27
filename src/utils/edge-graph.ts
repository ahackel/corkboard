// Junctions (lines meeting away from any card) are CUT: an older board's are flattened on load into a
// STAR of card-to-card lines from the first card that reached each.
import type { EdgeCap } from '../core/state.js';

export interface GraphEdge {
  id: string; from: string; to: string;
  color: string; dashed: boolean; fromCap: EdgeCap; toCap: EdgeCap; label: string;
}

export function flattenJunctions<E extends GraphEdge>(edges: E[], isJunction: (id: string) => boolean): E[] {
  // Junctions joined junction-to-junction are one meeting point (union-find).
  const root = new Map<string, string>();
  const find = (j: string): string => {
    let r = j;
    while (root.has(r) && root.get(r) !== r) {
      r = root.get(r)!;
    }
    root.set(j, r);
    return r;
  };
  for (const e of edges) {
    if (isJunction(e.from)) {
      find(e.from);
    }
    if (isJunction(e.to)) {
      find(e.to);
    }
    if (isJunction(e.from) && isJunction(e.to)) {
      root.set(find(e.from), find(e.to));
    }
  }

  // The cards reaching each meeting point, in board order, with the line and cap they came in by.
  const reach = new Map<string, Array<{ card: string; cap: EdgeCap; via: E }>>();
  const plain: E[] = [];
  for (const e of edges) {
    const fj = isJunction(e.from), tj = isJunction(e.to);
    if (!fj && !tj) { plain.push(e); continue; }
    if (fj && tj) {
      continue;
    }
    const j = find(fj ? e.from : e.to);
    const card = fj ? e.to : e.from, cap = fj ? e.toCap : e.fromCap;
    if (!reach.has(j)) {
      reach.set(j, []);
    }
    reach.get(j)!.push({ card, cap, via: e });
  }
  const out = plain.slice();
  for (const ends of reach.values()) {
    const [hub, ...rest] = ends;
    for (const r of rest) {
      if (r.card === hub.card) {
        continue;
      }
      out.push({ ...r.via, from: hub.card, to: r.card, fromCap: hub.cap, toCap: r.cap });
    }
  }
  return out;
}
