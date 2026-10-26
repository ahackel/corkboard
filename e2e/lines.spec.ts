import { test, expect } from '@playwright/test';
import { openBoard, makeCard, drawLine, select, clickPort, clickAway, reload, card, watchErrors } from './helpers';

const lines = (page: import('@playwright/test').Page) => page.locator('#freeEdgeHits path.fe-hit');

test('a line drawn from a port routes as an elbow and survives a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const a = await makeCard(page, 300, 250, 'Source');
  const b = await makeCard(page, 750, 500, 'Target');
  await drawLine(page, a, 'right', b);
  await expect(lines(page)).toHaveCount(1);
  const d = await page.locator('#freeEdges path.fe').first().getAttribute('d');
  expect(d).toMatch(/Q/);   // a rounded bend: an elbow, not a straight segment
  await reload(page);
  await expect(lines(page)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('two cards join again through DIFFERENT ports, never twice through the same ones', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 250, 'Source');
  const b = await makeCard(page, 750, 500, 'Target');
  await drawLine(page, a, 'right', b, 'up');
  await drawLine(page, a, 'down', b, 'left');
  await expect(lines(page)).toHaveCount(2);
  await drawLine(page, a, 'right', b, 'up');   // the same two ports again: no new line
  await expect(lines(page)).toHaveCount(2);
  await reload(page);
  await expect(lines(page)).toHaveCount(2);
});

test('clicking a port ⊕ makes a connected card; abandoning it takes the line too', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 400, 250, 'Parent');
  await select(page, a);
  await clickPort(page, 'down');
  await page.keyboard.type('Child');
  await clickAway(page);
  await expect(card(page, 'Child')).toBeVisible();
  await expect(lines(page)).toHaveCount(1);
  const pb = (await a.boundingBox())!, cb = (await card(page, 'Child').boundingBox())!;
  expect(cb.y).toBeGreaterThan(pb.y + pb.height);   // below, the side that was clicked
  // another ⊕, left empty: nothing stays behind
  await select(page, a);
  await clickPort(page, 'right');
  await page.keyboard.press('Escape');
  await clickAway(page);
  await expect(page.locator('#world .node')).toHaveCount(2);
  await expect(lines(page)).toHaveCount(1);
});

test('a selected line shows its end handles above it, and its toolbar never covers it', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 250, 'Upper');
  const b = await makeCard(page, 300, 360, 'Lower');
  await drawLine(page, b, 'up', a);
  await expect(page.locator('circle.fe-handle')).toHaveCount(2);
  const bar = (await page.locator('#edgeBar').boundingBox())!;
  const line = (await page.locator('#freeEdges path.fe').first().boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(line.y);
  const z = (sel: string) => page.locator(sel).evaluate(el => Number(getComputedStyle(el).zIndex));
  expect(await z('svg#toggles')).toBeGreaterThan(await z('svg#freeEdges'));
});
