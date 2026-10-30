// A drop FILES cards off the canvas: onto a folded section's pill (into it), or onto a crumb of the
// open-section path (up to that level) — features/drag.ts chuteAt/fileAway. And the search's "1/2" and
// chevrons, which find a match even inside a folded section never read.
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, seedBoard, note, section, card, watchErrors, diskFiles } from './helpers';

const BOARD = {
  'Loose.md': note('A loose card'),
  'Box/_index.md': note('# Box', { 'mm_type': 'frame' }),
  'Box/One.md': note('First inside'),
  'Box/Two.md': note('Second inside'),
  'Shelf/_index.md': note('# Shelf', { 'mm_type': 'frame' }),
  'Shelf/Inner.md': note('Inner card'),
  'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 }, edges: [], nodes: {
    'Loose.md': { x: 0, y: 420 }, 'Box/_index.md': { x: 0, y: 0, w: 300, h: 300, collapsed: true },
    'Box/One.md': { x: 40, y: 60 }, 'Box/Two.md': { x: 40, y: 160 },
    'Shelf/_index.md': { x: 400, y: 0, w: 300, h: 300 }, 'Shelf/Inner.md': { x: 440, y: 60 } } }),
};

async function dragOnto(page: Page, what: Locator, onto: Locator): Promise<void> {
  const a = (await what.boundingBox())!, b = (await onto.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test('a card dropped on a folded pill is filed into that section', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const pill = page.locator('#world .node.section-folded', { hasText: 'Box' });
  await dragOnto(page, card(page, 'A loose card'), pill);
  await expect(card(page, 'A loose card')).toBeHidden();
  await expect(pill).toHaveAttribute('title', /\b3 Cards\b/);
  expect(Object.keys(await diskFiles(page))).toContain('Box/A loose card.md');
  expect(errors).toEqual([]);
});

test('inside an open section, a card dropped on the map crumb moves up to the top level', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await section(page, 'Shelf').locator(':scope > .title-row').click();
  await page.keyboard.press('ControlOrMeta+ArrowDown');   // open it
  await page.waitForTimeout(500);
  await dragOnto(page, card(page, 'Inner card'), page.locator('#folderName'));
  await expect(card(page, 'Inner card')).toBeHidden();   // it left the section you are in
  expect(Object.keys(await diskFiles(page))).toContain('Inner card.md');
  expect(errors).toEqual([]);
});

test('search counts its matches, folded ones too, and the chevrons step through them', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await page.keyboard.press('Control+f');
  await page.keyboard.type('inside');
  await expect(page.locator('#searchCount')).toHaveText('1/2');
  await expect(page.locator('#world .node.section-folded', { hasText: 'Box' }).locator('.section-hits')).toHaveText('2 matches');
  await page.locator('#searchNext').click();
  await expect(page.locator('#searchCount')).toHaveText('2/2');
  await expect(page.locator('#searchWrap')).toHaveClass(/open/);   // stepping doesn't end the search
  expect(errors).toEqual([]);
});

test('leaving a section never moves it, even when a card inside was dragged past its edge', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const shelf = section(page, 'Shelf');
  const at = async () => { const b = (await shelf.boundingBox())!; return [Math.round(b.x), Math.round(b.y)]; };
  const before = await at();
  await shelf.locator(':scope > .title-row').click();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.waitForTimeout(300);
  // inside, the canvas is the section's interior: drag its card up and to the left, past where the box was
  const c = (await card(page, 'Inner card').boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 - 250, c.y + c.height / 2 - 120, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  await page.waitForTimeout(300);
  expect(await at()).toEqual(before);
  // …and the card came back inside it
  const box = (await shelf.boundingBox())!, inner = (await card(page, 'Inner card').boundingBox())!;
  expect(inner.x).toBeGreaterThanOrEqual(box.x); expect(inner.y).toBeGreaterThanOrEqual(box.y);
  expect(errors).toEqual([]);
});

test('going to a search hit inside a folded section enters the section and leaves it folded', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await page.keyboard.press('Control+f');
  await page.keyboard.type('Second inside');
  await expect(page.locator('#searchCount')).toHaveText('1/1');   // read out of the folded section
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveClass(/scoped/);
  await expect(card(page, 'Second inside')).toBeVisible();
  await page.locator('#folderName').click();                     // back out to the map
  await expect(page.locator('#world .node.section-folded', { hasText: 'Box' })).toBeVisible();   // never unfolded
  expect(errors).toEqual([]);
});

test('starting a search lets go of the selection, so the float bar is out of the way', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await card(page, 'A loose card').click();
  await expect(page.locator('#floatBar')).toHaveClass(/open/);
  await page.keyboard.press('Control+f');
  await expect(page.locator('#world .node.sel')).toHaveCount(0);
  await expect(page.locator('#floatBar')).not.toHaveClass(/open/);
  expect(errors).toEqual([]);
});

test('stepping through the matches glides the camera to each, selecting nothing', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, {
    'One.md': note('Alpha one'), 'Two.md': note('Alpha two'),
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: { 'One.md': { x: 0, y: 0 }, 'Two.md': { x: 3000, y: 2000 } } }),
  });
  await page.keyboard.press('Control+f');
  await page.keyboard.type('alpha');
  const view = (): Promise<string> => page.locator('#world').evaluate(el => el.style.transform);
  const before = await view();
  await page.locator('#searchNext').click();
  await page.waitForTimeout(700);
  const after = await view();
  expect(after).not.toBe(before);
  await page.keyboard.press('ArrowDown');   // the list arrows go there too
  await page.waitForTimeout(700);
  expect(await view()).not.toBe(after);
  await expect(page.locator('#world .node.sel')).toHaveCount(0);
  await expect(page.locator('#world .node.search-active')).toHaveCount(1);
  expect(errors).toEqual([]);
});
