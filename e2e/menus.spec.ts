import { test, expect, type Page } from '@playwright/test';
import { openBoard, makeCard, select, watchErrors } from './helpers';

async function menuItems(page: Page): Promise<string[]> {
  return page.$$eval('#ctxMenu > *', els => els.map(e => e.className === 'cm-sep' ? '---' : (e.querySelector('span')?.textContent ?? '')));
}

test('a card’s right-click menu is grouped like FigJam’s, and Lock works from it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'A card');
  await select(page, c);
  const b = (await c.boundingBox())!;
  await page.mouse.click(b.x + 30, b.y + 15, { button: 'right' });
  expect(await menuItems(page)).toEqual([
    'Copy', 'Cut', 'Paste', 'Duplicate', 'Duplicate as the next one', '---', 'Delete', '---', 'Edit', 'Wrap in new section', 'Resize to fit', '---',
    'Copy file path', 'Download as Markdown', '---', 'Lock',
  ]);
  await page.locator('#ctxMenu .cm-item', { hasText: /^Lock/ }).click();
  await expect(c.locator('.lock-badge')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the canvas menu offers paste, a new card, an image, select all and zoom', async ({ page }) => {
  await openBoard(page);
  await page.mouse.click(700, 500, { button: 'right' });
  expect(await menuItems(page)).toEqual(['Paste here', '---', 'New card', 'Insert image…', '---', 'Select all', 'Zoom to fit']);
});

test('the dock Actions button and ⌘P open the palette just above the dock, bottom centre', async ({ page }) => {
  await openBoard(page);
  await page.locator('#paletteBtn').click();
  const box = page.locator('.pal-box');
  await expect(box).toBeVisible();
  await expect(page.locator('#palInput')).toBeFocused();
  const b = (await box.boundingBox())!, d = (await page.locator('#dock').boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(d.y);
  expect(d.y - (b.y + b.height)).toBeLessThan(20);
  expect(Math.abs((b.x + b.width / 2) - (d.x + d.width / 2))).toBeLessThan(2);
  // typing filters the list above the input; the input itself stays put next to the dock
  const i0 = (await page.locator('#palInput').boundingBox())!;
  await page.locator('#palInput').fill('undo');
  expect((await page.locator('#palInput').boundingBox())!.y).toBe(i0.y);
  expect((await box.boundingBox())!.height).toBeLessThan(b.height);
  // a press outside closes it; ⌘P brings it back
  await page.mouse.click(100, 200);
  await expect(box).toBeHidden();
  await page.keyboard.press('Control+p');
  await expect(box).toBeVisible();
});

test('the browser theme colour follows the canvas colour', async ({ page }) => {
  await openBoard(page);
  const theme = () => page.locator('meta[name="theme-color"]').getAttribute('content');
  expect(await theme()).toBe('rgb(245, 245, 245)');   // the board's own grey
  await page.locator('#canvasColorBtn').click();
  const chip = page.locator('#canvasColors .swatch[data-color]:not([data-color=""])').first();
  const want = await chip.evaluate(el => getComputedStyle(el).getPropertyValue('--sw').trim());
  await chip.click();
  await expect.poll(theme).not.toBe('rgb(245, 245, 245)');
  const got = await theme();
  expect(await page.evaluate(([w]) => { const i = document.createElement('i'); i.style.color = w; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; }, [want])).toBe(got);
  if (!(await page.locator('#canvasColors').isVisible())) {
    await page.locator('#canvasColorBtn').click();
  }
  await page.locator('#canvasColors .swatch[data-color=""]').click();
  await expect.poll(theme).toBe('rgb(245, 245, 245)');
});
