import { test, expect, type Page } from '@playwright/test';
import { openBoard, section, card, palette, watchErrors, tooltip, saved } from './helpers';

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
  await expect(page.locator('#folderName .sc-name')).toHaveText('picked');   // the folder map is open
  await saved(page);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
      async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
  });
});

test('a note saved into the Inbox folder from elsewhere shows up inside it, which keeps its size, and pulses', async ({ page }) => {
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
  const before = (await section(page, 'Inbox').boundingBox())!;

  // the phone saves a note into the folder; coming back to the window re-reads it
  await seedFolder(page, { 'Inbox/2026-10-27 0915.md': 'Buy oat milk\n' });
  await saved(page);
  await page.waitForTimeout(650);   // past the reload's own-write guard (persistence.ts)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const arrived = card(page, 'Buy oat milk');
  await expect(arrived).toBeVisible();
  await expect(arrived).toHaveClass(/arrived/);
  const a = (await arrived.boundingBox())!, box = (await section(page, 'Inbox').boundingBox())!;
  expect(box).toEqual(before);                              // a section is never resized for what arrives
  expect(a.x).toBeGreaterThanOrEqual(box.x); expect(a.y).toBeGreaterThanOrEqual(box.y);   // it stacks inside, from the top-left
  expect(a.x + a.width).toBeLessThanOrEqual(box.x + box.width);
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
  const pill = page.locator('#world .node.section-folded', { hasText: 'Inbox' });
  await expect.poll(() => tooltip(page, pill)).toMatch(/\b1 Card\b/);
  await seedFolder(page, { 'Inbox/Two.md': 'Two\n' });
  await saved(page);
  await page.waitForTimeout(650);   // past the reload's own-write guard
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => tooltip(page, pill)).toMatch(/\b2 Cards\b/);
  await expect(pill).toHaveClass(/arrived/);
  // the palette's Inbox reads it and opens it up
  await palette(page, 'Inbox');
  await expect(card(page, 'Two')).toBeVisible();
  await expect(card(page, 'One')).toBeVisible();
});

test('the palette’s Inbox makes the Inbox section beside the board, then goes to it', async ({ page }) => {
  await openBoard(page);
  await seedFolder(page, { 'Loose.md': 'A loose card\n',
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: { 'Loose.md': { x: 0, y: 0 } } }) });
  await openFolder(page);
  await palette(page, 'Inbox');
  const inbox = section(page, 'Inbox');
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
  await expect(page.locator('#world .node.section', { hasText: 'Inbox' })).toHaveCount(1);
});

test('coming back to the window with nothing changed on disk keeps the undo history', async ({ page }) => {
  await openBoard(page);
  await seedFolder(page, {
    'Keep.md': 'Keep\n',
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: { 'Keep.md': { x: 100, y: 100 } } }),
  });
  await openFolder(page);
  const keep = card(page, 'Keep');
  await expect(keep).toBeVisible();
  const b = (await keep.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('Backspace');
  await expect(keep).toHaveCount(0);
  await saved(page);
  await page.waitForTimeout(650);   // past the reload's own-write guard
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(card(page, 'Keep')).toBeVisible();
});

test('notes changing on disk leave the selection on the same card', async ({ page }) => {
  await openBoard(page);
  await seedFolder(page, {
    'A.md': 'Ay\n', 'M.md': 'Em\n', 'Z.md': 'Zed\n',
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: {
      'A.md': { x: 100, y: 100 }, 'M.md': { x: 400, y: 100 }, 'Z.md': { x: 700, y: 100 } } }),
  });
  await openFolder(page);
  const em = card(page, 'Em');
  const b = (await em.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await expect(em).toHaveClass(/\bsel\b/);
  await saved(page);
  await page.waitForTimeout(650);   // past the reload's own-write guard
  // Another app deletes BOTH its neighbours: whichever way the folder is read, the card's fresh id shifts.
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked');
    await root.removeEntry('A.md'); await root.removeEntry('Z.md');
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(card(page, 'Ay')).toHaveCount(0);
  await expect(card(page, 'Em')).toHaveClass(/\bsel\b/);
});
