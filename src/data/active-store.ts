// The open map: the active `store` adapter and its registry entry. Switched by useStore (data/persistence.ts).
import { opfsStore, type Store, type MapKind } from '../store/index.js';

// eslint-disable-next-line import-x/no-mutable-exports -- live binding, reassigned only by setActiveStore
export let store: Store = opfsStore;

// Unlike the persisted last-map key, which another tab may rewrite. Null for non-registry stores.
// eslint-disable-next-line import-x/no-mutable-exports -- live binding, reassigned only by setActiveStore
export let currentMap: { kind: MapKind; id: string } | null = null;

export function setActiveStore(s: Store, ref: { kind: MapKind; id: string } | null): void {
  store = s;
  currentMap = ref;
}
