// STACKS — a section drawn as a pile (features/stacks.ts): hold a dragged card over another to make one, drop
// on a pile to add to it, drag the pile's body to lift its top card off, drag its pin to move it whole, click
// it to fan it out. Down to one card, it's no stack any more.
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, seedBoard, note, card, makeCard, watchErrors, diskFiles, palette, select, centre, dragTo } from './helpers';

const NODES = {
  'Loose.md': { x: 400, y: 0 },
  'Pile/_index.md': { x: 0, y: 0, stack: true, order: ['Pile/One.md', 'Pile/Two.md', 'Pile/Three.md'] },
  'Pile/One.md': { x: 0, y: 0 }, 'Pile/Two.md': { x: 0, y: 0 }, 'Pile/Three.md': { x: 0, y: 0 },
};
const board = (nodes: Record<string, unknown>): string =>
  JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 }, edges: [], nodes });
const BOARD = {
  'Loose.md': note('A loose card'),
  'Pile/_index.md': note('', { 'mm_type': 'frame', 'mm_blank': 'true' }),
  'Pile/One.md': note('Bottom card'),
  'Pile/Two.md': note('Middle card'),
  'Pile/Three.md': note('Top card'),
  'board.json': board(NODES),
};

const stack = (page: Page): Locator => page.locator('#world .node.stack');

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
  await dragTo(page, await centre(a), await centre(b), { hold: 700 });
  await expect(stack(page)).toHaveCount(1);
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
  // the new stack is selected, and its ring goes round the whole pile, not along one edge of it
  const ring = (await stack(page).locator('.stack-ring').boundingBox())!;
  const pile = (await stack(page).locator('.pile').boundingBox())!;
  expect(ring.height).toBeGreaterThanOrEqual(pile.height);
  expect(ring.width).toBeGreaterThanOrEqual(pile.width);
  await expect(stack(page).locator('.pile-card').last()).toContainText('Alpha');   // the last one added is on top
  const files = Object.keys(await diskFiles(page));
  expect(files).toEqual(expect.arrayContaining(['Stack/_index.md', 'Stack/Alpha.md', 'Stack/Beta.md']));
  expect(errors).toEqual([]);
});

test('a plain drop on a stack puts the card on top of it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await expect(stack(page)).toHaveAttribute('data-cards', '3');
  // the bottom card lies square; the ones on it are askew
  await expect(stack(page).locator('.pile-card').first()).toHaveCSS('rotate', '0deg');
  await expect(stack(page).locator('.pile-card').nth(1)).not.toHaveCSS('rotate', '0deg');
  await dragTo(page, await centre(card(page, 'A loose card')), await centre(stack(page)));
  await expect(stack(page)).toHaveAttribute('data-cards', '4');
  await expect(stack(page).locator('.pile-card').last()).toContainText('A loose card');
  expect(Object.keys(await diskFiles(page))).toContain('Pile/A loose card.md');
  expect(errors).toEqual([]);
});

test('dragging the pile lifts its top card off; dragging the pin moves the whole stack', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const at = await centre(stack(page));
  await dragTo(page, at, { x: at.x + 250, y: at.y + 200 });
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
  await expect(page.locator('#world .node:not(.stack)', { hasText: 'Top card' })).toBeVisible();
  const before = (await stack(page).boundingBox())!;
  const pin = await centre(stack(page).locator('.stack-pin'));
  await dragTo(page, pin, { x: pin.x - 150, y: pin.y + 120 });
  const after = (await stack(page).boundingBox())!;
  expect(after.x).toBeLessThan(before.x - 100);
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
  expect(errors).toEqual([]);
});

test('a stack down to one card lets it go', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  for (const i of [0, 1]) {
    const at = await centre(stack(page));
    await dragTo(page, at, { x: at.x + 240, y: at.y + 160 + i * 120 });
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
  await dragTo(page, from, { x: 1100, y: 700 });
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(0);
  await expect(page.locator('#fanScrim')).toHaveCount(0);
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
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
  await page.mouse.up();
  await expect(page.locator('#fanInsert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // it went to the BOTTOM of the pile (the far end of the fan), so the middle card is on top now
  await expect(stack(page).locator('.pile-card').last()).toContainText('Middle card');
  expect(errors).toEqual([]);
});

test('a stack\'s colour is its pin\'s, red by default; its cards keep their own', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, { ...BOARD,
    'Blue/_index.md': note('', { 'mm_type': 'frame', 'mm_blank': 'true', 'color': 'blue' }),
    'Blue/A.md': note('Blue one'), 'Blue/B.md': note('Blue two'),
    'board.json': board({ ...NODES, 'Blue/_index.md': { x: 0, y: 400, stack: true }, 'Blue/A.md': { x: 0, y: 0 }, 'Blue/B.md': { x: 0, y: 0 } }) });
  const pin = stack(page).filter({ hasText: 'Top card' }).locator('.stack-pin');
  const blue = stack(page).filter({ hasText: 'Blue' });
  await expect(pin).toHaveCSS('background-color', 'rgb(242, 72, 34)');
  await expect(blue.locator('.stack-pin')).not.toHaveCSS('background-color', 'rgb(242, 72, 34)');
  await expect(blue.locator('.pile-card').last()).toHaveClass(/c-amber/);   // its cards keep a sticky's own yellow
  // …and the colour picker shows the red for an uncoloured one, not the white of an uncoloured section
  await select(page, pin);
  await expect(page.locator('#edColors .swatch.active')).toHaveAttribute('data-color', 'bold-red');
  expect(errors).toEqual([]);
});
