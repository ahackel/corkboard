// File operations over a FileSystemDirectoryHandle, shared by the OPFS and FSA adapters.
import type { NoteFile, TreeListing } from './types.js';
import { planTree, type FoldTest } from './tree.js';

// Nothing is read yet. Dot-folders (`.obsidian`, `.trash`) are another app's business and never walked.
async function listPaths(root: FileSystemDirectoryHandle, under: string): Promise<Map<string, FileSystemFileHandle>> {
  const out = new Map<string, FileSystemFileHandle>();
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, h] of handle.entries()){
      if (name.startsWith('.')) {
        continue;
      }
      if (h.kind === 'directory') {
        await walk(h as FileSystemDirectoryHandle, prefix + name + '/');
      } else {
        out.set(prefix + name, h as FileSystemFileHandle);
      }
    }
  };
  let start = root;
  try {
    for (const part of under.split('/').filter(Boolean)) {
      start = await start.getDirectoryHandle(part);
    }
  }
  catch { return out; }                       // the folder isn't there (any more)
  await walk(start, under);
  return out;
}
// Several at a time: on a synced folder each read is a round trip. `stamp` is filled from the same walk.
const READS_AT_ONCE = 16;
export async function listTree(root: FileSystemDirectoryHandle, under: string, fold: FoldTest,
                               stamp?: Map<string, string>): Promise<TreeListing> {
  const handles = await listPaths(root, under);
  const plan = planTree([...handles.keys()], under, fold);
  const files: NoteFile[] = new Array(plan.read.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < plan.read.length; i = next++) {
      const path = plan.read[i], f = await handles.get(path)!.getFile();
      stamp?.set(path, stampOf(f));
      files[i] = { path, text: await f.text() };
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, plan.read.length) }, worker));
  if (stamp) {
    const unread = [...handles].filter(([path]) => !stamp.has(path));
    await Promise.all(unread.map(async ([path, h]) => { stamp.set(path, stampOf(await h.getFile())); }));
  }
  return { files, lazy: plan.lazy, foreign: plan.foreign, assets: plan.assets };
}
// Every file's size and modification time, by path, without reading a byte.
export async function folderStamp(root: FileSystemDirectoryHandle): Promise<Map<string, string>> {
  const handles = await listPaths(root, '');
  const out = new Map<string, string>();
  await Promise.all([...handles].map(async ([path, h]) => { out.set(path, stampOf(await h.getFile())); }));
  return out;
}

export function stampOf(f: File): string { return f.size + ':' + f.lastModified; }

// Never recursive: anything another app left in it keeps the folder alive.
export async function removeEmptyDir(root: FileSystemDirectoryHandle, dir: string): Promise<void> {
  try {
    const [d, name] = await resolvePath(root, dir.replace(/\/$/, ''));
    await d.removeEntry(name);
  } catch { /* not empty, or already gone */ }
}
// [the directory holding the leaf, the leaf name]. Without `create` a missing dir throws.
async function resolvePath(root: FileSystemDirectoryHandle, path: string, create = false): Promise<[FileSystemDirectoryHandle, string]> {
  const parts = path.split('/'); let d = root;
  for (let i=0;i<parts.length-1;i++) {
    d = await d.getDirectoryHandle(parts[i], { create });
  }
  return [d, parts[parts.length-1]];
}
export async function writeFile(root: FileSystemDirectoryHandle, path: string, data: string | Blob): Promise<File> {
  const [d, name] = await resolvePath(root, path, true);
  const h = await d.getFileHandle(name, { create:true });
  const w = await h.createWritable(); await w.write(data); await w.close();
  return h.getFile();
}
export async function removeFile(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  try {
    const [d, name] = await resolvePath(root, path);
    await d.removeEntry(name);
  } catch { /* already gone */ }
}
export async function readFileBlob(root: FileSystemDirectoryHandle, path: string): Promise<Blob | null> {
  try {
    const [d, name] = await resolvePath(root, path);
    return await (await d.getFileHandle(name)).getFile();
  } catch { return null; }
}
