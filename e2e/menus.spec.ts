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
    'Copy', 'Copy as formatted text', 'Cut', 'Paste', 'Duplicate', 'Duplicate as the next one', '---', 'Delete', '---', 'Edit', 'Wrap in new section', 'Resize to fit', '---',
    'Copy file path', 'Download as Markdown', '---', 'Lock',
  ]);
  await page.locator('#ctxMenu .cm-item', { hasText: /^Lock/ }).click();
  await expect(c.locator('.lock-badge')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the canvas menu offers paste, a new card, an image, select all and zoom', async ({ page }) => {
  await openBoard(page);
  await page.mouse.click(700, 500, { button: 'right' });
  expect(await menuItems(page)).toEqual(['Paste here', '---', 'New card', 'Insert image…', '---', 'Select all', 'Fit the map to the screen']);
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
  await page.locator('#settingsBtn').click();
  await page.locator('#canvasColorBtn').click();
  const chip = page.locator('#canvasColors .swatch[data-color]:not([data-color=""])').first();
  const want = await chip.evaluate(el => getComputedStyle(el).getPropertyValue('--sw').trim());
  await chip.click();
  await expect.poll(theme).not.toBe('rgb(245, 245, 245)');
  const got = await theme();
  expect(await page.evaluate(([w]) => { const i = document.createElement('i'); i.style.color = w; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; }, [want])).toBe(got);
  if (!(await page.locator('#canvasColorBtn').isVisible())) {
    await page.locator('#settingsBtn').click();
  }
  await page.locator('#canvasColorBtn').click();
  await page.locator('#canvasColors .swatch[data-color=""]').click();
  await expect.poll(theme).toBe('rgb(245, 245, 245)');
});

test('a right-click in a card’s text lists the editor’s commands with their keys, and they act on the selection', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await page.mouse.move(400, 300);
  await page.keyboard.press('n');
  const ta = page.locator('textarea.body-edit');
  await expect(ta).toBeFocused();
  await page.keyboard.type('one two');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  const b = (await ta.boundingBox())!;
  await page.mouse.click(b.x + b.width - 4, b.y + 4, { button: 'right' });
  expect(await menuItems(page)).toEqual([
    'Cut', 'Copy', 'Paste', 'Paste as plain text', '---', 'Bold', 'Italic', 'Strikethrough', 'Link to a card…', 'Tag…', '---',
    'Task / tick it', 'Indent', 'Outdent', 'Move line up', 'Move line down', '---', 'Selection to a new card', 'Done', '---',
    'Spelling suggestions',
  ]);
  const keysShown = await page.$$eval('#ctxMenu .cm-item', els => els.map(e => e.querySelector('kbd')?.textContent ?? ''));
  expect(keysShown).toContain('⇧Tab');
  await page.locator('#ctxMenu .cm-item', { hasText: /^Bold/ }).click();
  await expect(page.locator('#ctxMenu')).not.toHaveClass(/open/);
  await expect(ta).toBeFocused();                      // the menu took no focus: the editor is still open…
  await expect(ta).toHaveValue('one **two**');        // …and Bold wrapped what was selected
  await page.mouse.click(b.x + 10, b.y + 4, { button: 'right' });
  await page.locator('#ctxMenu .cm-item', { hasText: /^Task/ }).click();
  await expect(ta).toHaveValue('- [ ] one **two**');
  expect(errors).toEqual([]);
});

test('the editor menu’s Paste runs the editor’s own paste: a URL over a selection links it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openBoard(page);
  await page.mouse.move(400, 300);
  await page.keyboard.press('n');
  const ta = page.locator('textarea.body-edit');
  await page.keyboard.type('see docs');
  await page.evaluate(() => navigator.clipboard.writeText('https://example.com'));
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  const b = (await ta.boundingBox())!;
  await page.mouse.click(b.x + b.width - 4, b.y + 4, { button: 'right' });
  await page.locator('#ctxMenu .cm-item', { hasText: /^Paste(?! as)/ }).click();
  await expect(ta).toHaveValue('see [docs](https://example.com)');
  await expect(ta).toBeFocused();
});
