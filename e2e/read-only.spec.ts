// Read-only mode: R toggles it, and only a CHANGE is announced — opening a board says nothing about it.
import { test, expect } from '@playwright/test';
import { openBoard, makeCard, saved, watchErrors } from './helpers.js';

test('opening a board says nothing about read-only; R turns it on and off, and says so', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const toast = page.locator('#status');
  await expect(toast).not.toContainText('Read-only');
  await makeCard(page, 400, 300, 'A card');
  await saved(page);
  await page.reload();
  await expect(page.locator('#world .node')).toHaveCount(1);
  await expect(toast).not.toContainText('Read-only');

  await page.keyboard.press('r');
  await expect(toast).toHaveText('Read-only is on. Nothing is saved.');
  await expect(page.locator('#roBadge')).toBeVisible();
  await page.keyboard.press('r');
  await expect(toast).toHaveText('Read-only is off');
  await expect(page.locator('#roBadge')).toBeHidden();
  expect(errors).toEqual([]);
});
