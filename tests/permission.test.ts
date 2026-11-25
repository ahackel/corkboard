import { describe, it, expect } from 'vitest';
import { sameEntry } from '../src/store/permission.js';

// A handle whose comparison Chrome rejects — what a remembered folder that moved or was deleted gives.
function handle(answer: () => Promise<boolean>): FileSystemHandle {
  return { isSameEntry: answer } as unknown as FileSystemHandle;
}

describe('sameEntry', () => {
  it('answers what the browser answers', async () => {
    expect(await sameEntry(handle(async () => true), handle(async () => true))).toBe(true);
    expect(await sameEntry(handle(async () => false), handle(async () => false))).toBe(false);
  });

  it('takes a stale handle the browser refuses to compare as a different one', async () => {
    const stale = handle(() => Promise.reject(new DOMException('The user aborted a request.', 'AbortError')));
    expect(await sameEntry(stale, handle(async () => true))).toBe(false);
  });
});
