import { test, expect, type Page } from '@playwright/test';
import { openBoard, frame, card, palette, watchErrors } from './helpers';

// A "folder on disk" for the File System Access store: the picker is stubbed to hand back a folder in
// the browser's private storage — the same directory-handle API a real folder has — so the board runs
// on the folder store, with its re-read-on-focus, exactly as it does on a Mac.
async function seedFolder(page: Page, files: Record<string, string>): Promise<void> {
  await page.evaluate(async (files) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split('/');
      let d = root;
      for (const p of parts.slice(0, -1)) {
        d = await d.getDirectoryHandle(p, { create: true });
      }
      const w = await (await d.getFileHandle(parts[parts.length - 1]!, { create: true })).createWritable();
      await w.write(text); await w.close();
    }
  }, files);
}
async function openFolder(page: Page): Promise<void> {
  await page.locator('#homeBtn').click();
  await page.locator('#tabFolder').click();
  await page.locator('#newBtn').click();
  await page.waitForTimeout(600);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
      async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
  });
});

test('a note saved into the Inbox folder from elsewhere shows up beside its cards, and pulses', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedFolder(page, {
    'Inbox/_index.md': '# Inbox\n',
    'Inbox/Old note.md': 'Old note\n',
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: {
      'Inbox/_index.md': { x: 0, y: 0, w: 400, h: 300 }, 'Inbox/Old note.md': { x: 30, y: 30 } } }),
  });
  await openFolder(page);
  await expect(card(page, 'Old note')).toBeVisible();

  // the phone saves a note into the folder; coming back to the window re-reads it
  await seedFolder(page, { 'Inbox/2026-10-27 0915.md': 'Buy oat milk\n' });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const arrived = card(page, 'Buy oat milk');
  await expect(arrived).toBeVisible();
  await expect(arrived).toHaveClass(/arrived/);
  const old = (await card(page, 'Old note').boundingBox())!, a = (await arrived.boundingBox())!;
  const box = (await frame(page, 'Inbox').boundingBox())!;
  expect(a.x).toBeGreaterThan(old.x + old.width);          // beside the card already there, not on it
  expect(a.x + a.width).toBeLessThanOrEqual(box.x + box.width);   // and inside the frame, which grew
  expect(a.y + a.height).toBeLessThanOrEqual(box.y + box.height);
  await expect(arrived).not.toHaveClass(/arrived/, { timeout: 4000 });   // the pulse ends
  expect(errors).toEqual([]);
});

test('a note that lands in a FOLDED Inbox pulses its pill, which counts it', async ({ page }) => {
  await openBoard(page);
  await seedFolder(page, {
    'Inbox/_index.md': '# Inbox\n',
    'Inbox/One.md': 'One\n',
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: {
      'Inbox/_index.md': { x: 0, y: 0, w: 400, h: 300, collapsed: true } } }),
  });
  await openFolder(page);
  const pill = page.locator('#world .node.frame-folded', { hasText: 'Inbox' });
  await expect(pill.locator('.frame-count')).toHaveText('1');
  await seedFolder(page, { 'Inbox/Two.md': 'Two\n' });
  await page.waitForTimeout(700);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(pill.locator('.frame-count')).toHaveText('2');
  await expect(pill).toHaveClass(/arrived/);
  // the palette's Inbox reads it and opens it up
  await palette(page, 'Inbox');
  await expect(card(page, 'Two')).toBeVisible();
  await expect(card(page, 'One')).toBeVisible();
});

test('the palette’s Inbox makes the Inbox frame beside the board, then goes to it', async ({ page }) => {
  await openBoard(page);
  await seedFolder(page, { 'Loose.md': 'A loose card\n',
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: { 'Loose.md': { x: 0, y: 0 } } }) });
  await openFolder(page);
  await palette(page, 'Inbox');
  const inbox = frame(page, 'Inbox');
  await expect(inbox).toBeVisible();
  const f = (await inbox.boundingBox())!, c = (await card(page, 'A loose card').boundingBox())!;
  expect(f.x + f.width).toBeLessThan(c.x);   // to the left of what's there, on nothing
  // its folder is written, so the phone has somewhere to save into
  await expect.poll(() => page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
    try { await (await root.getDirectoryHandle('Inbox')).getFileHandle('_index.md'); return true; } catch { return false; }
  })).toBe(true);
  // a second time just goes there
  await palette(page, 'Inbox');
  await expect(page.locator('#world .node.frame', { hasText: 'Inbox' })).toHaveCount(1);
});
