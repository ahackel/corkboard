import { test, expect, type Page } from '@playwright/test';
import { openBoard, seedBoard, note, frame, card, clickAway, reload, watchErrors } from './helpers';

const BOARD = {
  'Todo.md': note('# Todo', { 'mm_type': 'frame' }),
  'Milk.md': note('Buy milk', { 'mm_parent': 'Todo.md' }),
  'Loose.md': note('A loose card'),
  // a frame saved FOLDED: it opens as its label pill
  'Old.md': note('# Old', { 'mm_type': 'frame', 'mm_collapsed': 'true' }),
  'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 },
    edges: [{ id: 'e1', from: 'Loose.md', to: 'Milk.md' }], nodes: {
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

test('a frame folds to its label pill: its cards hide, its lines meet the pill, a double-click opens it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  // saved folded → a 40px pill, no box
  const old = page.locator('#world .node.frame-folded', { hasText: 'Old' });
  await expect(old).toBeVisible();
  expect(Math.round((await old.boundingBox())!.height)).toBe(40);
  // fold Todo from the float bar
  const todo = frame(page, 'Todo');
  await todo.locator(':scope > .title-row').click();
  await page.locator('#fbFold').click();
  const pill = page.locator('#world .node.frame-folded', { hasText: 'Todo' });
  await expect(pill).toBeVisible();
  await expect(pill.locator('.frame-count')).toHaveText('1');
  await expect(card(page, 'Buy milk')).toBeHidden();
  await expect(page.locator('#freeEdges path.fe')).toHaveCount(1);   // Loose → Milk now ends on the pill
  // drag the pill; its hidden card comes along
  const pb = (await pill.boundingBox())!;
  await page.mouse.move(pb.x + 30, pb.y + 20);
  await page.mouse.down();
  await page.mouse.move(pb.x + 130, pb.y + 20, { steps: 8 });
  await page.mouse.up();
  await reload(page);
  const again = page.locator('#world .node.frame-folded', { hasText: 'Todo' });
  await again.dblclick();
  await expect(frame(page, 'Todo')).toBeVisible();
  await page.waitForTimeout(650);                                // the box grows back, animated
  const milk = (await card(page, 'Buy milk').boundingBox())!, box = (await frame(page, 'Todo').boundingBox())!;
  expect(milk.x).toBeGreaterThan(box.x); expect(milk.x + milk.width).toBeLessThan(box.x + box.width);
  expect(errors).toEqual([]);
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

test('a dragged frame is what lifts: it casts the shadow, its cards keep their resting one', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, BOARD);
  const todo = frame(page, 'Todo');
  const lb = (await todo.locator(':scope > .title-row').boundingBox())!;
  await page.mouse.move(lb.x + 10, lb.y + 8);
  await page.mouse.down();
  await page.mouse.move(lb.x + 60, lb.y + 40, { steps: 6 });
  const shadow = (sel: string) => page.locator(sel).first().evaluate(el => getComputedStyle(el).boxShadow);
  expect(await shadow('#world .node.frame.dragging')).toContain('32px');
  expect(await shadow('#world .node.carried')).not.toContain('32px');
  await page.mouse.up();
});

test('nothing floats beside a selected card or folded frame: a double-click edits', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, BOARD);
  const old = page.locator('#world .node.frame-folded', { hasText: 'Old' });
  await old.click();
  await expect(page.locator('#world .addnote')).toHaveCount(0);
});

test('zoomed out, a frame name keeps its screen size while the box shrinks', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, BOARD);
  const label = frame(page, 'Todo').locator(':scope > .title-row');
  const lb0 = (await label.boundingBox())!, fb0 = (await frame(page, 'Todo').boundingBox())!;
  await page.mouse.move(fb0.x + 20, fb0.y + 20);
  for (let i = 0; i < 6; i++) { await page.keyboard.down('Control'); await page.mouse.wheel(0, 200); await page.keyboard.up('Control'); }
  await expect.poll(async () => (await frame(page, 'Todo').boundingBox())!.height).toBeLessThan(fb0.height * 0.6);
  const lb = (await label.boundingBox())!, fb = (await frame(page, 'Todo').boundingBox())!;
  expect(Math.abs(lb.height - lb0.height)).toBeLessThan(2);
  // still just above the box, flush with its left edge, and no wider than it
  expect(Math.abs(lb.y + lb.height + 7 - fb.y)).toBeLessThan(2);
  expect(Math.abs(lb.x - fb.x)).toBeLessThan(2);
  expect(lb.width).toBeLessThanOrEqual(fb.width + 1);
});
