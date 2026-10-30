// STACKS — a section drawn as a pile (features/stacks.ts): hold a dragged card over another to make one, drop
// on a pile to add to it, drag the pile's body to lift its top card off, drag its pin to move it whole, click
// it to fan it out. Down to one card, it's no stack any more.
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, seedBoard, note, card, makeCard, watchErrors, diskFiles, palette, select } from './helpers';

const BOARD = {
  'Loose.md': note('A loose card'),
  'Pile/_index.md': note('', { 'mm_type': 'frame', 'mm_blank': 'true' }),
  'Pile/One.md': note('Bottom card'),
  'Pile/Two.md': note('Middle card'),
  'Pile/Three.md': note('Top card'),
  'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 }, edges: [], nodes: {
    'Loose.md': { x: 400, y: 0 },
    'Pile/_index.md': { x: 0, y: 0, stack: true, order: ['Pile/One.md', 'Pile/Two.md', 'Pile/Three.md'] },
    'Pile/One.md': { x: 0, y: 0 }, 'Pile/Two.md': { x: 0, y: 0 }, 'Pile/Three.md': { x: 0, y: 0 } } }),
};

const stack = (page: Page): Locator => page.locator('#world .node.stack');

async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Drag from one point to another; `hold` rests on the target before letting go (what makes a stack).
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, hold = 0): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (hold) {
    await page.waitForTimeout(hold);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

test('holding a card over another makes a stack; a quick pass does not', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const a = await makeCard(page, 300, 300, 'Alpha');
  const b = await makeCard(page, 700, 300, 'Beta');
  // passing over Beta on the way somewhere else is just a pass
  await page.mouse.move((await centre(a)).x, (await centre(a)).y);
  await page.mouse.down();
  await page.mouse.move((await centre(b)).x, (await centre(b)).y, { steps: 8 });
  await page.mouse.move(1000, 560, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(stack(page)).toHaveCount(0);
  await drag(page, await centre(a), await centre(b), 700);
  await expect(stack(page)).toHaveCount(1);
  await expect(stack(page).locator('.stack-count')).toHaveText('2');
  await expect(stack(page).locator('.pile-card').last()).toContainText('Alpha');   // the last one added is on top
  const files = Object.keys(await diskFiles(page));
  expect(files).toEqual(expect.arrayContaining(['Stack/_index.md', 'Stack/Alpha.md', 'Stack/Beta.md']));
  expect(errors).toEqual([]);
});

test('a plain drop on a stack puts the card on top of it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await expect(stack(page).locator('.stack-count')).toHaveText('3');
  await drag(page, await centre(card(page, 'A loose card')), await centre(stack(page)));
  await expect(stack(page).locator('.stack-count')).toHaveText('4');
  await expect(stack(page).locator('.pile-card').last()).toContainText('A loose card');
  expect(Object.keys(await diskFiles(page))).toContain('Pile/A loose card.md');
  expect(errors).toEqual([]);
});

test('dragging the pile lifts its top card off; dragging the pin moves the whole stack', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const at = await centre(stack(page));
  await drag(page, at, { x: at.x + 250, y: at.y + 200 });
  await expect(stack(page).locator('.stack-count')).toHaveText('2');
  await expect(page.locator('#world .node:not(.stack)', { hasText: 'Top card' })).toBeVisible();
  const before = (await stack(page).boundingBox())!;
  const pin = await centre(stack(page).locator('.stack-pin'));
  await drag(page, pin, { x: pin.x - 150, y: pin.y + 120 });
  const after = (await stack(page).boundingBox())!;
  expect(after.x).toBeLessThan(before.x - 100);
  await expect(stack(page).locator('.stack-count')).toHaveText('2');
  expect(errors).toEqual([]);
});

test('a stack down to one card lets it go', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  for (const i of [0, 1]) {
    const at = await centre(stack(page));
    await drag(page, at, { x: at.x + 240, y: at.y + 160 + i * 120 });
  }
  await expect(stack(page)).toHaveCount(0);
  await expect(card(page, 'Bottom card')).toBeVisible();
  const files = Object.keys(await diskFiles(page));
  expect(files).toContain('Bottom card.md');
  expect(files.some(f => f.startsWith('Pile/'))).toBe(false);
  expect(errors).toEqual([]);
});

test('a click fans the stack out, and Esc puts it back', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await stack(page).click();
  await page.waitForTimeout(700);
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(3);
  await expect(page.locator('#fanScrim')).toBeVisible();
  // a fanned card dragged out onto the board leaves the stack
  const top = page.locator('#world .node.fanned', { hasText: 'Top card' });
  const from = await centre(top);
  await drag(page, from, { x: 1100, y: 700 });
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(0);
  await expect(page.locator('#fanScrim')).toHaveCount(0);
  await expect(stack(page).locator('.stack-count')).toHaveText('2');
  expect(errors).toEqual([]);
});

test('Unstack spreads the cards out; Turn into section keeps them in a box', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await select(page, stack(page).locator('.stack-pin'));
  await palette(page, 'Turn into section');
  await expect(stack(page)).toHaveCount(0);
  await expect(page.locator('#world .node.section')).toHaveCount(1);
  for (const t of ['Top card', 'Middle card', 'Bottom card']) {
    await expect(card(page, t)).toBeVisible();
  }
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(300);
  await expect(stack(page)).toHaveCount(1);
  await select(page, stack(page).locator('.stack-pin'));
  await palette(page, 'Unstack');
  await expect(stack(page)).toHaveCount(0);
  await expect(page.locator('#world .node.section')).toHaveCount(0);
  const boxes = await Promise.all(['Top card', 'Middle card', 'Bottom card'].map(t => card(page, t).boundingBox()));
  expect(new Set(boxes.map(b => `${Math.round(b!.x)},${Math.round(b!.y)}`)).size).toBe(3);   // no longer on one spot
  expect(Object.keys(await diskFiles(page))).toContain('Top card.md');
  expect(errors).toEqual([]);
});

test('dragging a card within the fan shows a line where it will go, and drops it there', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await stack(page).click();
  await page.waitForTimeout(700);
  const top = page.locator('#world .node.fanned:visible', { hasText: 'Top card' });
  const last = (await page.locator('#world .node.fanned:visible', { hasText: 'Bottom card' }).boundingBox())!;
  await page.mouse.move((await centre(top)).x, (await centre(top)).y);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width * 0.8, last.y + last.height / 2, { steps: 12 });
  await expect(page.locator('#fanInsert')).toBeVisible();
  await expect(page.locator('#world .node.drop-slot')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/fan-insert.png' });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await expect(page.locator('#fanInsert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // it went to the BOTTOM of the pile (the far end of the fan), so the middle card is on top now
  await expect(stack(page).locator('.pile-card').last()).toContainText('Middle card');
  await page.screenshot({ path: 'test-results/pin.png' });
  expect(errors).toEqual([]);
});
