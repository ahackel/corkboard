import { test, expect } from '@playwright/test';
import { openBoard, makeCard, select, clickAway, reload, card, watchErrors } from './helpers';

test('a card is made, edited and kept across a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Plan\nWrite the tests');
  await expect(c.locator('.body h1')).toHaveText('Plan');
  await reload(page);
  await expect(card(page, 'Plan')).toContainText('Write the tests');
  expect(errors).toEqual([]);
});

test('a card resizes on both axes; its height is a minimum, kept across a reload', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'Short');
  await select(page, c);
  const b = (await c.boundingBox())!;
  await page.mouse.move(b.x + b.width - 2, b.y + b.height - 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 80, b.y + b.height + 150, { steps: 8 });
  await page.mouse.up();
  const grown = (await c.boundingBox())!;
  expect(grown.width).toBeGreaterThan(b.width + 60);
  expect(grown.height).toBeGreaterThan(b.height + 120);
  await reload(page);
  const after = (await card(page, 'Short').boundingBox())!;
  expect(Math.round(after.height)).toBe(Math.round(grown.height));
});

test('opening a card for editing does not change its size', async ({ page }) => {
  await openBoard(page);
  for (const [i, text] of ['Hi', '# Title only', 'A list\n- a\n- b'].entries()) {
    const c = await makeCard(page, 300 + i * 260, 300, text);
    const before = (await c.boundingBox())!.height;
    await c.dblclick();
    await expect(c.locator('textarea.body-edit')).toBeVisible();
    expect(Math.abs((await c.boundingBox())!.height - before)).toBeLessThan(1);
    await page.keyboard.press('Escape');
    await clickAway(page);
  }
});
