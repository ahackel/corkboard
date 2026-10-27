// Pure file operations over a FileSystemDirectoryHandle. The OPFS and FSA adapters share
// the same handle-based API and differ ONLY in how they obtain the root handle, so the
// actual list/write/remove/read logic lives here once (DRY) and both adapters delegate.
import type { NoteFile, TreeListing } from './types.js';
import { planTree, type FoldTest } from './tree.js';

// Every file under `under` ('' = the whole map), by NAME, with its handle — nothing is read yet, and the
// handles spare a second walk from the root per note when the notes are. Dot-folders (`.obsidian`,
// `.trash`) are another app's business and are never walked.
async function listPaths(root: FileSystemDirectoryHandle, under: string): Promise<Map<string, FileSystemFileHandle>> {
  const out = new Map<string, FileSystemFileHandle>();
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, h] of handle.entries()){
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, prefix + name + '/');
      else out.set(prefix + name, h as FileSystemFileHandle);
    }
  };
  let start = root;
  try { for (const part of under.split('/').filter(Boolean)) start = await start.getDirectoryHandle(part); }
  catch { return out; }                       // the folder isn't there (any more): nothing under it
  await walk(start, under);
  return out;
}
// The notes under `under`, minus the contents of every folder `fold` leaves unread (store/tree.ts).
// Read READS_AT_ONCE at a time rather than one by one: a map is hundreds of small files, and on a synced
// folder each read is a round trip. Bounded, so a huge map doesn't open every file at once.
const READS_AT_ONCE = 16;
export async function listTree(root: FileSystemDirectoryHandle, under: string, fold: FoldTest): Promise<TreeListing> {
  const handles = await listPaths(root, under);
  const plan = planTree([...handles.keys()], under, fold);
  const files: NoteFile[] = new Array(plan.read.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < plan.read.length; i = next++) {
      const path = plan.read[i];
      files[i] = { path, text: await (await handles.get(path)!.getFile()).text() };
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, plan.read.length) }, worker));
  return { files, lazy: plan.lazy, foreign: plan.foreign };
}
// Remove a folder if it is EMPTY — a frame's old folder after its notes moved out. Never recursive:
// whatever else is still in there (a file another app put there) keeps the folder alive.
export async function removeEmptyDir(root: FileSystemDirectoryHandle, dir: string): Promise<void> {
  try {
    const [d, name] = await resolvePath(root, dir.replace(/\/$/, ''));
    await d.removeEntry(name);
  } catch { /* not empty, or already gone — fine */ }
}
// Walk to the directory holding the final segment of `path`, returning [that dir, the leaf name].
// `create` makes the intermediate dirs as it goes (for writes); without it a missing dir throws.
async function resolvePath(root: FileSystemDirectoryHandle, path: string, create = false): Promise<[FileSystemDirectoryHandle, string]> {
  const parts = path.split('/'); let d = root;
  for (let i=0;i<parts.length-1;i++) d = await d.getDirectoryHandle(parts[i], { create });
  return [d, parts[parts.length-1]];
}
// Create/overwrite a note at a relative path (intermediate dirs created).
export async function writeFile(root: FileSystemDirectoryHandle, path: string, data: string | Blob): Promise<void> {
  const [d, name] = await resolvePath(root, path, true);
  const h = await d.getFileHandle(name, { create:true });
  const w = await h.createWritable(); await w.write(data); await w.close();
}
// Delete a note (a missing file is fine).
export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  try {
    const [d, name] = await resolvePath(root, path);
    await d.removeEntry(name);
  } catch { /* already gone — fine */ }
}
// Read a binary file (e.g. an image attachment) as a Blob, or null if it's gone.
export async function readFileBlob(root: FileSystemDirectoryHandle, path: string): Promise<Blob | null> {
  try {
    const [d, name] = await resolvePath(root, path);
    return await (await d.getFileHandle(name)).getFile();
  } catch { return null; }
}
