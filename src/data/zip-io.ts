// Import and export of a map as a .zip.
import { IMAGE_ACCEPT, IMAGE_FILE_RE } from '../utils/image-types.js';
import { unzip, zipBlob, entryPath } from '../utils/zip.js';
import { setStatus, state } from '../core/state.js';
import { createDeviceMap, resolveOnDeviceStore } from '../store/index.js';
import { switchToDeviceMap } from './persistence.js';
import { store } from './active-store.js';
import { BOARD_FILE, boardJSON } from './board.js';
import { dataHooks } from './hooks.js';
import { readAll } from './lazy.js';
import { commitRel } from '../view/layout.js';
import { slugStem, safeName, dirOf } from '../utils/filenames.js';
import { serializeMd } from '../utils/frontmatter.js';
import { bodyImages } from '../utils/markdown.js';
import { downloadBlob } from '../utils/download.js';
import { readImage } from './images.js';
import { loadFromDir } from './load.js';

const importInput = Object.assign(document.createElement('input'), {
  type: 'file',
  accept: '.zip,.md,.markdown,' + IMAGE_ACCEPT,
  multiple: true,
});

export function installImportPicker(): void {
  importInput.style.display = 'none';
  document.body.appendChild(importInput);
  importInput.addEventListener('change', async () => {
    const files = [...(importInput.files || [])];
    importInput.value = '';
    if (files.length) {
      await importFiles(files);
    }
  });
}

export function openImportPicker(): void {
  importInput.click();
}

interface ImportEntry { name: string; text?: string; bytes?: Uint8Array }
async function importFiles(files: File[]): Promise<void> {
  let entries: ImportEntry[] = [];
  for (const f of files){
    if (/\.zip$/i.test(f.name)) {
      try { entries.push(...await unzip(await f.arrayBuffer())); } catch { setStatus('That .zip could not be read.'); }
    } else if (/\.(md|markdown)$/i.test(f.name)) {
      entries.push({ name: f.name, text: await f.text() });
    } else if (IMAGE_FILE_RE.test(f.name)) {
      entries.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  // Finder's `__MACOSX/._Note.md` and other hidden files would also hide the common top folder below.
  const junk = (name: string): boolean => name.split('/').some(p => p.startsWith('.') || p === '__MACOSX');
  entries = entries.filter(e => !junk(e.name))
    .flatMap(e => { const name = entryPath(e.name); return name ? [{ ...e, name }] : []; });
  let md  = entries.filter(e => /\.(md|markdown)$/i.test(e.name) && !e.name.endsWith('/'));
  let img = entries.filter(e => e.bytes && IMAGE_FILE_RE.test(e.name) && !e.name.endsWith('/'));
  if (!md.length){ setStatus('No Markdown files found to import.'); return; }
  // Always a new on-device map, never merged into the current one.
  const zipBase = files.find(f => /\.zip$/i.test(f.name))?.name.replace(/\.zip$/i, '').trim();
  const ref = await createDeviceMap(await resolveOnDeviceStore(), zipBase || 'Imported map');
  await switchToDeviceMap(ref);
  // Strip a common top folder so relative image links resolve, unless a root board.json says it's a section.
  const slash = md[0].name.indexOf('/');
  const top = slash >= 0 ? md[0].name.slice(0, slash + 1) : '';
  if (top && md.every(e => e.name.startsWith(top)) && !entries.some(e => e.name === BOARD_FILE)){
    md  = md.map(e => ({ ...e, name: e.name.slice(top.length) }));
    img = img.map(e => e.name.startsWith(top) ? { ...e, name: e.name.slice(top.length) } : e);
  }
  // The store already points at the new map, so the canvas must follow it whatever fails below.
  let skipped = 0;
  const put = async (name: string, data: string | Blob): Promise<void> => {
    try {
      await store.write(name, data);
    } catch (err) {
      console.error(`Import: could not write ${name}`, err);
      skipped++;
    }
  };
  for (const e of md) {
    await put(e.name, e.text ?? '');
  }
  for (const e of img) {
    await put(e.name, new Blob([e.bytes! as BlobPart]));
  }
  const board = entries.find(e => e.text != null && (e.name === BOARD_FILE || e.name === top + BOARD_FILE));
  if (board?.text != null) {
    await put(BOARD_FILE, board.text);
  }
  dataHooks.leaveHome();
  await loadFromDir();
  setStatus(`Imported ${md.length} note${md.length===1?'':'s'}${img.length ? ` + ${img.length} image${img.length===1?'':'s'}` : ''}`
    + (skipped ? ` — ${skipped} file${skipped === 1 ? '' : 's'} could not be written.` : '.'));
}

export async function exportZip(): Promise<void> {
  await readAll();   // folded sections' notes included
  const nodes = [...state.nodes.values()];
  if (!nodes.length){ setStatus('Nothing to export yet.'); return; }
  commitRel();
  // Lowercased: the folder this unpacks into may collide case-insensitively.
  const used = new Set<string>();
  const files: Array<{ name: string; data?: string; bytes?: Uint8Array }> = nodes.map(n => {
    let name = n.file || (slugStem(n) + '.md');
    while (used.has(name.toLowerCase())) {
      name = name.replace(/(\.md)?$/, '') + '-1.md';
    }
    used.add(name.toLowerCase());
    return { name, data: serializeMd(n) };
  });
  // Packed at the path each picture was FOUND at, so the zip holds the file the note shows.
  const refs = new Map<string, { src: string; file: string | null | undefined }>();
  for (const n of nodes) {
    for (const { src } of bodyImages(n.body)) {
      if (!/^(https?:|data:)/i.test(src)) {
        refs.set(dirOf(n.file ?? '') + '\0' + src, { src, file: n.file });
      }
    }
  }
  const found = await Promise.all([...refs.values()].map(r => readImage(r.src, r.file)));
  const packed = new Set<string>();
  for (const img of found) {
    if (img && !packed.has(img.path)) {
      packed.add(img.path);
      files.push({ name: img.path, bytes: new Uint8Array(await img.blob.arrayBuffer()) });
    }
  }
  const attached = packed.size;
  files.push({ name: BOARD_FILE, data: boardJSON() });
  const zipName = safeName(store.name || 'corkboard') + '.zip';
  downloadBlob(zipBlob(files), zipName);
  setStatus(`Exported ${nodes.length} notes${attached ? ` + ${attached} image${attached === 1 ? '' : 's'}` : ''} → ${zipName}`);
}
