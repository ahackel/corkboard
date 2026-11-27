// The map registry: ONE localStorage list of every map (on-device, folder, note), plus the last-map key.
// Disk lifecycle of on-device maps is the store adapter's.
import { readJSON, writeJSON } from '../utils/local-json.js';
import type { DeviceStore } from './types.js';

export interface MapRef {
  id: string;                    // device: OPFS dir name ('vault' = the legacy pre-multi-map dir); folder/note: FSA handle key
  kind: 'device' | 'folder' | 'note';
  name: string;
  when: number;                  // last opened / created (ms since epoch)
}
export type MapKind = MapRef['kind'];

const MAPS_KEY = 'corkboard.maps';
const LAST_MAP_KEY = 'corkboard.lastMap'; // {kind, id} — what boot() reopens

export function readMaps(): MapRef[] { return readJSON<MapRef[]>(MAPS_KEY, []); }
function writeMaps(list: MapRef[]): void {
  writeJSON(MAPS_KEY, [...list].sort((a, b) => b.when - a.when));
}
export function upsertMap(ref: MapRef): void {
  writeMaps([ref, ...readMaps().filter(m => m.id !== ref.id)]);
}
export function removeMapRef(id: string): void { writeMaps(readMaps().filter(m => m.id !== id)); }
export function touchMap(id: string): void {
  const m = readMaps().find(m => m.id === id);
  if (m) {
    upsertMap({ ...m, when: Date.now() });
  }
}

export function getLastMap(): { kind: MapKind; id: string } | null {
  return readJSON<{ kind: MapKind; id: string } | null>(LAST_MAP_KEY, null);
}
export function setLastMap(kind: MapKind, id: string): void { writeJSON(LAST_MAP_KEY, { kind, id }); }

// Lets the registry be rebuilt from disk if localStorage is cleared.
export const MAP_META_FILE = 'map.json';
export function serializeMapMeta(name: string): string { return JSON.stringify({ name }); }
export function parseMapMetaName(text: string): string | null {
  try {
    const j = JSON.parse(text);
    if (typeof j?.name === 'string' && j.name) {
      return j.name;
    }
  } catch {}
  return null;
}

// Also its OPFS dir name under maps/.
function newMapId(): string {
  return 'm' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
// "Untitled", "Untitled 2", …
function uniqueMapName(base: string, names = new Set(readMaps().map(m => m.name))): string {
  if (!names.has(base)) {
    return base;
  }
  let i = 2;
  while (names.has(`${base} ${i}`)) {
    i++;
  }
  return `${base} ${i}`;
}

export async function createDeviceMap(s: DeviceStore, name?: string): Promise<MapRef> {
  const id = newMapId();
  const finalName = uniqueMapName((name || 'Untitled').trim() || 'Untitled');
  await s.createMap(id, finalName);
  const ref: MapRef = { id, kind: 'device', name: finalName, when: Date.now() };
  upsertMap(ref);
  return ref;
}
export async function deleteDeviceMap(s: DeviceStore, id: string): Promise<void> {
  await s.deleteMap(id);
  removeMapRef(id);
}
export async function renameDeviceMap(s: DeviceStore, id: string, name: string): Promise<void> {
  const finalName = name.trim();
  if (!finalName) {
    return;
  }
  await s.renameMap(id, finalName);
  const m = readMaps().find(m => m.id === id);
  if (m) {
    upsertMap({ ...m, name: finalName });
  }
}

// An empty registry is rebuilt from the legacy recents list and the maps on disk. These keys already
// carry the new prefix: utils/legacy-keys.ts renames `mindmap.*` before anything reads them.
const LEGACY_RECENTS_KEY = 'corkboard.recentFolders';
const LEGACY_LAST_STORE_KEY = 'corkboard.lastStore';

export async function ensureMapRegistry(s: DeviceStore): Promise<void> {
  if (readMaps().length) {
    return;
  }
  const refs: MapRef[] = [];
  for (const r of readJSON<Array<{ key: string; name: string; when: number }>>(LEGACY_RECENTS_KEY, [])) {
    refs.push({ id: r.key, kind: 'folder', name: r.name, when: r.when });
  }
  for (const m of await s.listMaps()) {
    refs.push({ id: m.id, kind: 'device', name: uniqueMapName(m.name, new Set(refs.map(r => r.name))), when: 0 });
  }
  if (!refs.length) {
    return;
  }
  writeMaps(refs);
  try { localStorage.removeItem(LEGACY_RECENTS_KEY); } catch {}
  if (!getLastMap()) {
    let legacy: string | null = null;
    try { legacy = localStorage.getItem(LEGACY_LAST_STORE_KEY); } catch {}
    const first = (kind: MapKind) => refs.find(m => m.kind === kind);
    const pick = legacy === 'folder' ? (first('folder') ?? first('device')) : (first('device') ?? null);
    if (pick) {
      setLastMap(pick.kind, pick.id);
    }
  }
}
