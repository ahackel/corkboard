import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, makeCard, clickAway } from './helpers';

const editor = (c: Locator) => c.locator('textarea.body-edit');
// Open a fresh card with N and leave its editor open, for the keys under test.
async function freshEditor(page: Page): Promise<Locator> {
  await page.mouse.move(400, 300);
  await page.keyboard.press('n');
  await page.waitForTimeout(120);
  return page.locator('textarea.body-edit');
}

test('Enter continues a list, and Enter on an empty item ends it', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('- milk\neggs\n\nafter');
  await expect(ta).toHaveValue('- milk\n- eggs\nafter');
  await page.keyboard.press('Escape');
});

test('Tab nests an item, ⇧Tab lifts it, and the card renders the nesting', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('- a\nb');
  await page.keyboard.press('Tab');
  await expect(ta).toHaveValue('- a\n  - b');
  await expect(ta).toBeFocused();                    // Tab didn't take focus off the card
  await page.keyboard.press('Shift+Tab');
  await expect(ta).toHaveValue('- a\n- b');
  await page.keyboard.press('Tab');
  await clickAway(page);
  await expect(page.locator('#world .node .body ul > li > ul > li')).toHaveText('b');
});

test('⌘B wraps the selection, and ⌘Z in the editor takes it back', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('make it bold');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 12));
  await page.keyboard.press('ControlOrMeta+b');
  await expect(ta).toHaveValue('make it **bold**');
  await page.keyboard.press('ControlOrMeta+i');
  await expect(ta).toHaveValue('make it ***bold***');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(ta).toHaveValue('make it **bold**');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(ta).toHaveValue('make it bold');
  await page.keyboard.press('Escape');
});

test('the editor shows the note in a monospace face', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'Some text');
  await c.dblclick();
  const family = await editor(c).evaluate(el => getComputedStyle(el).fontFamily);
  expect(family).toMatch(/monospace/);
});
