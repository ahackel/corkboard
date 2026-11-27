// ============================================================
// The map that is open: the active `store` adapter and which registry entry it is. Every module that
// reads or writes the map imports it from here; data/persistence.ts useStore is what switches it.
// ============================================================
import { opfsStore, type Store, type MapKind } from '../store/index.js';

// Local-first: on-device until "Open folder" swaps in fsaStore.
// eslint-disable-next-line import-x/no-mutable-exports -- a live binding, reassigned only by setActiveStore (follow-up: a getter)
export let store: Store = opfsStore;

// Which map is on the canvas RIGHT NOW — in-memory runtime state, unlike the persisted
// last-map key (which another tab may rewrite). null for non-registry stores.
// eslint-disable-next-line import-x/no-mutable-exports -- a live binding, reassigned only by setActiveStore (follow-up: a getter)
export let currentMap: { kind: MapKind; id: string } | null = null;

export function setActiveStore(s: Store, ref: { kind: MapKind; id: string } | null): void {
  store = s;
  currentMap = ref;
}
