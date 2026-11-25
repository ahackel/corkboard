import { describe, it, expect } from 'vitest';
import { sameEntry, ensureWrite } from '../src/store/permission.js';

const abort = (): Promise<never> => Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));

// A handle whose comparison Chrome rejects — what a remembered folder that moved or was deleted gives.
function handle(answer: () => Promise<boolean>): FileSystemHandle {
  return { isSameEntry: answer } as unknown as FileSystemHandle;
}

// A folder handle: its permission as asked and as queried, and whether reading it works.
function folder(query: () => Promise<string>, request: () => Promise<string>, read: () => Promise<unknown>): FileSystemHandle {
  return {
    kind: 'directory', queryPermission: query, requestPermission: request,
    entries: () => ({ next: read }),
  } as unknown as FileSystemHandle;
}

describe('sameEntry', () => {
  it('answers what the browser answers', async () => {
    expect(await sameEntry(handle(async () => true), handle(async () => true))).toBe(true);
    expect(await sameEntry(handle(async () => false), handle(async () => false))).toBe(false);
  });

  it('takes a stale handle the browser refuses to compare as a different one', async () => {
    expect(await sameEntry(handle(abort), handle(async () => true))).toBe(false);
  });
});

describe('ensureWrite', () => {
  const read = async (): Promise<unknown> => ({ done: true });

  it('is ok for a granted folder it can read', async () => {
    expect(await ensureWrite(folder(async () => 'granted', async () => 'granted', read))).toBe('ok');
  });

  it('is denied when the user refuses', async () => {
    expect(await ensureWrite(folder(async () => 'prompt', async () => 'denied', read))).toBe('denied');
  });

  it('needs a click when Chrome will not ask without one', async () => {
    const noGesture = (): Promise<never> => Promise.reject(new DOMException('no gesture', 'SecurityError'));
    expect(await ensureWrite(folder(async () => 'prompt', noGesture, read))).toBe('needs-click');
  });

  // a remembered handle Chrome no longer honours (moved, deleted, or stored before a browser update)
  it('is gone when asking for a dead handle throws, or a granted one cannot be read', async () => {
    expect(await ensureWrite(folder(abort, abort, read))).toBe('gone');
    expect(await ensureWrite(folder(async () => 'granted', async () => 'granted', abort))).toBe('gone');
  });
});
