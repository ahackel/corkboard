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

test('Esc on a line\'s label puts the old label back', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 250, 'Source');
  const b = await makeCard(page, 750, 500, 'Target');
  await drawLine(page, a, 'right', b);
  await clickAway(page);
  const mid = await lines(page).first().evaluate(el => {
    const path = el as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  const editLabel = async (text: string, key: string): Promise<void> => {
    await page.mouse.dblclick(mid.x, mid.y);
    await expect(page.locator('#ebLabelEdit')).toBeFocused();
    await page.keyboard.type(text);
    await page.keyboard.press(key);
  };
  await editLabel('kept', 'Enter');
  await expect(page.locator('#freeEdges .fe-label')).toHaveText('kept');
  await editLabel('dropped', 'Escape');
  await expect(page.locator('#freeEdges .fe-label')).toHaveText('kept');
});

test('a line toolbar\'s picker stays on screen at the window edge, and Esc closes it', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 1150, 250, 'Upper');
  const b = await makeCard(page, 1150, 400, 'Lower');
  await drawLine(page, b, 'up', a);
  await page.locator('#ebColor').click();
  const pop = page.locator('#ebColorPop');
  await expect(pop).toHaveClass(/open/);
  const box = (await pop.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press('Escape');
  await expect(pop).not.toHaveClass(/open/);
});
