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
    'Copy', 'Cut', 'Paste', 'Duplicate', '---', 'Delete', '---', 'Edit', 'Open', 'Group into frame', '---',
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
