import { test, expect } from '@playwright/test';
import { openBoard, makeCard, select, reload, card } from './helpers';

test('a card dragged shorter than its text clips it, keeps that height, and Fit gives it back', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 200, '# Long\none\ntwo\nthree\nfour\nfive\nsix\nseven');
  const full = (await c.boundingBox())!.height;
  await select(page, c);
  const s = (await c.locator(':scope > .fh-s').boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2, s.y - full / 2, { steps: 6 });
  await page.mouse.up();
  await expect(c).toHaveClass(/clipped/);
  await expect(page.locator('#fbFit')).toBeVisible();          // the bar offers Fit straight away
  const short = (await c.boundingBox())!.height;
  expect(short).toBeLessThan(full - 40);
  await reload(page);
  const again = card(page, 'Long');
  await expect(again).toHaveClass(/clipped/);
  expect(Math.abs((await again.boundingBox())!.height - short)).toBeLessThan(2);
  await select(page, again);
  await page.locator('#fbFit').click();
  await expect(again).not.toHaveClass(/clipped/);
  expect(Math.abs((await again.boundingBox())!.height - full)).toBeLessThan(2);
});
