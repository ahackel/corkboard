// The chrome round the canvas: the first-run hint, what Esc and ⇧-click do, the Back button, the sidebar.
import { test, expect } from '@playwright/test';
import { openBoard, makeCard, select, watchErrors, palette } from './helpers';

test('an empty map says how to begin, and stops once it holds a card', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await expect(page.locator('#emptyHint')).toBeVisible();
  await expect(page.locator('#emptyHint')).toContainText('press N to write a note');
  await makeCard(page, 400, 300, 'First');
  await expect(page.locator('#emptyHint')).toBeHidden();
  expect(errors).toEqual([]);
});

test('Esc closes the colour picker and leaves the card selected; a second Esc lets go of it', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 400, 300, 'One');
  await select(page, a);
  await page.locator('#fbColor').click();
  await expect(page.locator('#fbColorPop')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#fbColorPop')).not.toHaveClass(/open/);
  await expect(a).toHaveClass(/\bsel\b/);
  await page.keyboard.press('Escape');
  await expect(a).not.toHaveClass(/\bsel\b/);
});

test('⇧-click adds a card to the selection and takes it out again', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 300, 'One');
  const b = await makeCard(page, 600, 300, 'Two');
  await select(page, a);
  await b.click({ modifiers: ['Shift'] });
  await expect(page.locator('#world .node.sel')).toHaveCount(2);
  await b.click({ modifiers: ['Shift'] });
  await expect(page.locator('#world .node.sel')).toHaveCount(1);
  await expect(a).toHaveClass(/\bsel\b/);
});

test('selecting cards adds nothing to the Back button’s history', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 300, 'One');
  const b = await makeCard(page, 600, 300, 'Two');
  const before = await page.evaluate(() => history.length);
  for (const c of [a, b, a, b]) {
    await select(page, c);
  }
  await page.waitForTimeout(400);   // the URL follows the selection after a short debounce
  expect(await page.evaluate(() => history.length)).toBe(before);
  await expect.poll(() => page.url()).toContain('Two');
});

test('the closed sidebar takes no keyboard focus; New map is named on the spot', async ({ page }) => {
  await openBoard(page);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#startScreen'))).toBe(false);
  }
  await palette(page, 'New map');
  const name = page.locator('#mapList .mi-name-input');
  await expect(name).toBeFocused();
  await page.keyboard.type('Ideas');
  await page.keyboard.press('Enter');
  await expect(page.locator('#startScreen')).toHaveClass(/hidden/);
  await expect(page.locator('#folderName .sc-name')).toHaveText('Ideas');
});
