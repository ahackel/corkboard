// ---- import / export as .zip (move a map between devices / back it up) ----
import { IMAGE_ACCEPT, IMAGE_FILE_RE } from '../utils/image-types.js';
import { unzip, zipBlob } from '../utils/zip.js';
import { setStatus, state } from '../core/state.js';
import { createDeviceMap, resolveOnDeviceStore } from '../store/index.js';
import { switchToDeviceMap, store } from './persistence.js';
import { BOARD_FILE, boardJSON } from './board.js';
import { hideStart } from '../boot.js';
import { readAll } from './lazy.js';
import { commitRel } from '../view/layout.js';
import { slugStem, safeName } from '../utils/filenames.js';
import { serializeMd } from '../utils/frontmatter.js';
import { bodyImages } from '../utils/markdown.js';
import { downloadBlob } from '../utils/download.js';
import { loadFromDir } from './load.js';

const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.zip,.md,.markdown,' + IMAGE_ACCEPT;
importInput.multiple = true;
importInput.style.display = 'none';
document.body.appendChild(importInput);
importInput.addEventListener('change', async () => {
  const files = [...(importInput.files || [])];
  importInput.value = '';
  if (files.length) {
    await importFiles(files);
  }
});
export function openImportPicker(): void { importInput.click(); }

// The image formats this app takes, BY FILENAME — the one list, shared with features/attachments.ts,
// which needs it for the files an OS drop hands over with no MIME type at all (an .svg dragged out of
// a file manager is the common one).
interface ImportEntry { name: string; text?: string; bytes?: Uint8Array }
async function importFiles(files: File[]): Promise<void> {
  const entries: ImportEntry[] = [];
  for (const f of files){
    if (/\.zip$/i.test(f.name)) {
      try { entries.push(...await unzip(await f.arrayBuffer())); } catch { setStatus('That .zip could not be read.'); }
    } else if (/\.(md|markdown)$/i.test(f.name)) {
      entries.push({ name: f.name, text: await f.text() });
    } else if (IMAGE_FILE_RE.test(f.name)) {
      entries.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  let md  = entries.filter(e => /\.(md|markdown)$/i.test(e.name) && !e.name.endsWith('/'));
  let img = entries.filter(e => e.bytes && IMAGE_FILE_RE.test(e.name) && !e.name.endsWith('/'));
  if (!md.length){ setStatus('No Markdown files found to import.'); return; }
  // An import always ADDS a new on-device map, never merges into the current one — named
  // after the .zip when there is one.
  const zipBase = files.find(f => /\.zip$/i.test(f.name))?.name.replace(/\.zip$/i, '').trim();
  const ref = await createDeviceMap(await resolveOnDeviceStore(), zipBase || 'Imported map');
  await switchToDeviceMap(ref);
  // strip a single common top-level folder (e.g. a zip of "MyNotes/…") from notes AND attachments,
  // so the relative ![](attachments/…) links still resolve after import — unless that folder is a
  // FRAME of a zip this app wrote (its board.json at the root says so): then it is part of the map.
  const slash = md[0].name.indexOf('/');
  const top = slash >= 0 ? md[0].name.slice(0, slash + 1) : '';
  if (top && md.every(e => e.name.startsWith(top)) && !entries.some(e => e.name === BOARD_FILE)){
    md  = md.map(e => ({ ...e, name: e.name.slice(top.length) }));
    img = img.map(e => e.name.startsWith(top) ? { ...e, name: e.name.slice(top.length) } : e);
  }
  for (const e of md) {
    await store.write(e.name, e.text ?? '');
  }
  for (const e of img) {
    await store.write(e.name, new Blob([e.bytes! as BlobPart]));
  }
  // carry over the board file if the archive included one (matching the note top-folder strip)
  const board = entries.find(e => e.text != null && (e.name === BOARD_FILE || e.name === top + BOARD_FILE));
  if (board?.text != null) {
    await store.write(BOARD_FILE, board.text);
  }
  hideStart();
  await loadFromDir();
  setStatus(`Imported ${md.length} note${md.length===1?'':'s'}${img.length ? ` + ${img.length} image${img.length===1?'':'s'}` : ''}.`);
}

// download every current note (plus the image attachments they reference) packed into a .zip
export async function exportZip(): Promise<void> {
  await readAll();   // the zip is the WHOLE map, folded frames' notes included
  const nodes = [...state.nodes.values()];
  if (!nodes.length){ setStatus('Nothing to export yet.'); return; }
  commitRel();   // serializeMd persists rx/ry — refresh it from the live x/y first
  // Lowercased, because the folder this unpacks into collides case-insensitively on macOS/Windows —
  // same reason desiredFileFor tests that way.
  const used = new Set<string>();
  const files: Array<{ name: string; data?: string; bytes?: Uint8Array }> = nodes.map(n => {
    // A node that has never been saved has no file yet; name it the way desiredFileFor would, off
    // its title or (untitled) off its first line — hence the shared slugStem.
    let name = n.file || (slugStem(n) + '.md');
    while (used.has(name.toLowerCase())) {
      name = name.replace(/(\.md)?$/, '') + '-1.md';
    }
    used.add(name.toLowerCase());
    return { name, data: serializeMd(n) };
  });
  // collect every vault-relative image referenced in a body, and pack the files alongside the notes
  const refs = new Set<string>();
  for (const n of nodes) {
    for (const { src } of bodyImages(n.body)) {
      if (!/^(https?:|data:)/i.test(src)) {
        refs.add(src);
      }
    }
  }
  // read every referenced image concurrently, then pack the ones that resolved
  const images = await Promise.all([...refs].map(async path => {
    const blob = await store.readBlob(path);
    return blob ? { name: path, bytes: new Uint8Array(await blob.arrayBuffer()) } : null;
  }));
  const attached = images.filter(Boolean).length;
  for (const img of images) {
    if (img) {
      files.push(img);
    }
  }
  // Always: the board file now carries every node's position and size, so a zip without it would
  // unpack as a pile of notes with no layout.
  files.push({ name: BOARD_FILE, data: boardJSON() });
  const zipName = safeName(store.name || 'corkboard') + '.zip';   // the map's name, not a generic one
  downloadBlob(zipBlob(files), zipName);
  setStatus(`Exported ${nodes.length} notes${attached ? ` + ${attached} image${attached === 1 ? '' : 's'}` : ''} → ${zipName}`);
}
