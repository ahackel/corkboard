import { test, expect, type Page } from '@playwright/test';
import { openBoard, seedBoard, note, frame, card, clickAway, reload, watchErrors } from './helpers';

const BOARD = {
  'Todo.md': note('# Todo', { 'mm_type': 'frame' }),
  'Milk.md': note('Buy milk', { 'mm_parent': 'Todo.md' }),
  'Loose.md': note('A loose card'),
  // an OLD save: a frame stored folded — frames don't fold any more
  'Old.md': note('# Old', { 'mm_type': 'frame', 'mm_collapsed': 'true' }),
  'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 }, edges: [], nodes: {
    'Todo.md': { x: 0, y: 0, w: 300, h: 240 }, 'Milk.md': { x: 40, y: 60 },
    'Loose.md': { x: 0, y: 420 }, 'Old.md': { x: 400, y: 0, w: 260, h: 200, collapsed: true } } }),
};

// Which frame each card is drawn inside (its DOM host), by its first line.
async function hostOf(page: Page, text: string): Promise<string> {
  return card(page, text).evaluate(el => {
    const wrap = el.closest('.frame-content');
    const f = wrap?.previousElementSibling as HTMLElement | null;
    return f?.querySelector(':scope > .title-row')?.textContent?.trim() || 'top';
  });
}

test('a frame collects what it is moved over, and lets go when moved away', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  expect(await hostOf(page, 'Buy milk')).toBe('Todo');
  expect(await hostOf(page, 'A loose card')).toBe('top');
  // drag Todo by its label so its box covers the loose card
  const label = frame(page, 'Todo').locator(':scope > .title-row');
  const lb = (await label.boundingBox())!, fb = (await frame(page, 'Todo').boundingBox())!;
  const lc = (await card(page, 'A loose card').boundingBox())!;
  const dx = lc.x - 30 - fb.x, dy = lc.y - 30 - fb.y;
  await page.mouse.move(lb.x + 10, lb.y + 8);
  await page.mouse.down();
  await page.mouse.move(lb.x + 10 + dx, lb.y + 8 + dy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await hostOf(page, 'A loose card')).toBe('Todo');
  expect(await hostOf(page, 'Buy milk')).toBe('Todo');   // it carried its own card along
  await reload(page);
  expect(await hostOf(page, 'A loose card')).toBe('Todo');
  expect(errors).toEqual([]);
});

test('frames never fold: an old folded frame opens as its box, with no fold arrow', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, BOARD);
  const old = frame(page, 'Old');
  await expect(old).toBeVisible();
  expect((await old.boundingBox())!.height).toBeGreaterThan(100);
  await expect(page.locator('#world .node.frame[data-chip]')).toHaveCount(0);
  await expect(page.locator('#fbHide')).toHaveCount(0);
});

test('an untitled frame gets its name back from the T button', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, BOARD);
  const todo = frame(page, 'Todo');
  await todo.locator(':scope > .title-row').dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await clickAway(page);
  await expect(page.locator('#world .node.frame.no-title')).toHaveCount(1);
  const box = (await page.locator('#world .node.frame.no-title').boundingBox())!;
  await page.mouse.click(box.x + box.width - 15, box.y + box.height - 15);
  await page.locator('#fbTitle').click();
  await page.keyboard.type('Renamed');
  await page.keyboard.press('Enter');
  await expect(frame(page, 'Renamed')).toBeVisible();
});
