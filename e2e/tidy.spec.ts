import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, makeCard, watchErrors, clickAway } from './helpers';

async function selectAll(page: Page): Promise<void> {
  await clickAway(page);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(200);
}
const rect = async (c: Locator) => (await c.boundingBox())!;

test('Tidy up turns a messy row into an evenly spaced, aligned one — and ⌘Z puts it back', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const a = await makeCard(page, 200, 300, 'One');
  const b = await makeCard(page, 470, 315, 'Two');
  const c = await makeCard(page, 760, 290, 'Three');
  const before = await rect(b);
  await selectAll(page);
  await page.locator('#fbTidy').click();
  await page.locator('#ctxMenu .cm-item', { hasText: /^Tidy up/ }).click();
  await page.waitForTimeout(500);
  const [ra, rb, rc] = [await rect(a), await rect(b), await rect(c)];
  expect(Math.round(ra.y)).toBe(Math.round(rb.y));
  expect(Math.round(rb.y)).toBe(Math.round(rc.y));
  const gap1 = rb.x - (ra.x + ra.width), gap2 = rc.x - (rb.x + rb.width);
  expect(Math.abs(gap1 - gap2)).toBeLessThan(1);
  expect(rb.x).toBeLessThan(before.x);   // pulled in: the gap is the house spacing now
  await clickAway(page);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  const back = await rect(b);
  expect(Math.round(back.x)).toBe(Math.round(before.x));
  expect(Math.round(back.y)).toBe(Math.round(before.y));
  expect(errors).toEqual([]);
});

test('⌥A aligns left edges; the tidy button only shows for two or more', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 260, 200, 'One');
  const b = await makeCard(page, 420, 400, 'Two');
  await clickAway(page);
  await a.click();
  await expect(page.locator('#fbTidy')).toBeHidden();
  await selectAll(page);
  await expect(page.locator('#fbTidy')).toBeVisible();
  await page.keyboard.press('Alt+KeyA');
  await page.waitForTimeout(500);
  expect(Math.round((await rect(a)).x)).toBe(Math.round((await rect(b)).x));
});
