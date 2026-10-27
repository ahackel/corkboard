import { test, expect } from '@playwright/test';
import { openBoard, makeCard, select } from './helpers';

test('a resized card edge is pulled onto a neighbour edge, with a guide shown while dragging', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 400, 200, 'Above');
  const b = await makeCard(page, 400, 420, 'Below');
  // widen the top card by an off-grid amount so its right edge is somewhere only a guide finds
  await select(page, a);
  let e = (await a.locator(':scope > .fh-e').boundingBox())!;
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2 + 87, e.y + e.height / 2, { steps: 6 });
  await page.mouse.up();
  const ar = (await a.boundingBox())!;
  // now drag the bottom card's right edge to 3px short of it
  await select(page, b);
  e = (await b.locator(':scope > .fh-e').boundingBox())!;
  const br0 = (await b.boundingBox())!;
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2 + (ar.x + ar.width - 3 - (br0.x + br0.width)), e.y + e.height / 2, { steps: 8 });
  await expect(page.locator('#guides .guide').first()).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('#guides .guide')).toHaveCount(0);
  const br = (await b.boundingBox())!;
  expect(Math.abs(br.x + br.width - (ar.x + ar.width))).toBeLessThan(1);
});
