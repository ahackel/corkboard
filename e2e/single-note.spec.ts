// A single note opened on its own (store/note.ts) is a map of ONE card: it edits in place, and nothing
// adds a card beside it or takes it away. The file picker is stubbed with a file in the browser's own
// storage, which behaves like a picked file apart from the permission prompt. Reopening it on the next
// visit is NOT covered here: headless Chromium crashes reading a stored OPFS handle back out of
// IndexedDB after a reload, so that path (boot → noteStore.resume) is checked by hand in Chrome.
import { test, expect, type Page } from '@playwright/test';
import { openBoard, card, clickAway, palette, saved, settled, watchErrors } from './helpers';

const NOTE = '---\nauthor: me\n---\n\n# Shopping\n\n- milk\n';

async function stubPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proto = FileSystemHandle.prototype as unknown as Record<string, unknown>;
    proto.queryPermission ??= async () => 'granted';
    proto.requestPermission ??= async () => 'granted';
    (window as unknown as Record<string, unknown>).showOpenFilePicker = async () =>
      [await (await navigator.storage.getDirectory()).getFileHandle('Shopping.md')];
  });
}
const readNote = (page: Page, name: string): Promise<string | null> => page.evaluate(async (name) => {
  try {
    return await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile().then(f => f.text());
  } catch { return null; }
}, name);

test('a single note opens as one card, edits in place, and keeps its file and its other fields', async ({ page }) => {
  const errors = watchErrors(page);
  await stubPicker(page);
  await openBoard(page);
  await page.evaluate(async (text) => {
    const w = await (await (await navigator.storage.getDirectory()).getFileHandle('Shopping.md', { create: true })).createWritable();
    await w.write(text); await w.close();
  }, NOTE);
  await palette(page, 'Open a note');
  await expect(card(page, 'Shopping')).toBeVisible();
  await expect(page.locator('#world .node')).toHaveCount(1);
  await expect(page.locator('#folderName .sc-name')).toHaveText('Shopping');
  await expect(page.locator('#ghostCard')).toBeHidden();

  // nothing adds a card beside it, or takes it away
  await page.mouse.move(300, 200);
  await page.keyboard.press('n');
  await card(page, 'Shopping').click();
  await page.keyboard.press('d');
  await page.keyboard.press('Delete');
  await settled(page);
  await expect(page.locator('#world .node')).toHaveCount(1);

  // an edit, the title included, lands in the same file; the fields the app doesn't own stay
  await card(page, 'Shopping').dblclick();
  const ta = page.locator('textarea.body-edit');
  await expect(ta).toBeFocused();
  await ta.fill('# Groceries\n\n- milk\n- eggs');
  await clickAway(page);
  await saved(page);
  const text = await readNote(page, 'Shopping.md');
  expect(text).toContain('author: me');
  expect(text).toContain('# Groceries\n\n- milk\n- eggs');
  expect(await readNote(page, 'Groceries.md')).toBeNull();   // the file keeps the name it was opened by
  await expect(card(page, 'Groceries')).toBeVisible();
  expect(errors).toEqual([]);
});
