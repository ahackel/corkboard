import { test, expect, type Locator } from '@playwright/test';
import { openBoard, makeCard, select, clickAway, reload, card, watchErrors, seedBoard, note, settled, centre } from './helpers';

test('a card is made, edited and kept across a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Plan\nWrite the tests');
  await expect(c.locator('.body h1')).toHaveText('Plan');
  await reload(page);
  await expect(card(page, 'Plan')).toContainText('Write the tests');
  expect(errors).toEqual([]);
});

test('a card resizes on both axes; its height is a minimum, kept across a reload', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'Short');
  await select(page, c);
  const b = (await c.boundingBox())!;
  await page.mouse.move(b.x + b.width - 2, b.y + b.height - 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 80, b.y + b.height + 150, { steps: 8 });
  await page.mouse.up();
  const grown = (await c.boundingBox())!;
  expect(grown.width).toBeGreaterThan(b.width + 60);
  expect(grown.height).toBeGreaterThan(b.height + 120);
  await reload(page);
  const after = (await card(page, 'Short').boundingBox())!;
  expect(Math.round(after.height)).toBe(Math.round(grown.height));
});

test('opening a card for editing does not change its size', async ({ page }) => {
  await openBoard(page);
  for (const [i, text] of ['Hi', '# Title only', 'A list\n- a\n- b'].entries()) {
    const c = await makeCard(page, 300 + i * 260, 300, text);
    const before = (await c.boundingBox())!.height;
    await c.dblclick();
    await expect(c.locator('textarea.body-edit')).toBeVisible();
    expect(Math.abs((await c.boundingBox())!.height - before)).toBeLessThan(1);
    await page.keyboard.press('Escape');
    await clickAway(page);
  }
});

test('typing never changes a card\'s height, and its edge can be dragged while it is edited', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 300, 300, 'Hi');
  const h0 = (await c.boundingBox())!.height;
  await c.dblclick();
  const ta = c.locator('textarea.body-edit');
  await expect(ta).toBeFocused();
  await page.keyboard.insertText('\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten');
  expect(Math.abs((await c.boundingBox())!.height - h0)).toBeLessThan(1);

  const s = (await c.locator(':scope > .fh-s').boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2, s.y + 100, { steps: 6 });
  await page.mouse.up();
  await expect(ta).toBeFocused();                              // still editing
  const h1 = (await c.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0 + 60);
  await page.keyboard.insertText('\neleven\ntwelve\nthirteen\nfourteen');
  expect(Math.abs((await c.boundingBox())!.height - h1)).toBeLessThan(1);

  await clickAway(page);
  await settled(page);
  expect(Math.abs((await c.boundingBox())!.height - h1)).toBeLessThan(1);   // and committing keeps it
});

test('⇧D duplicates a card as the next of its series: next day, next slot of the row', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, {
    'Mon.md': note('# 2026-10-26 Monday\n\n- GPU memory optimization', { color: 'blue' }),
    'Tue.md': note('# 2026-10-27 Tuesday\n\n- GPU memory optimization', { color: 'blue' }),
    'board.json': JSON.stringify({ version: 1, model: 2, settings: {}, nodes: {
      'Mon.md': { x: 0, y: 0, w: 240, h: 300 }, 'Tue.md': { x: 280, y: 0, w: 240, h: 300 } } }),
  });
  const tue = card(page, 'Tuesday');
  await tue.click();
  await page.keyboard.press('Shift+D');
  await page.keyboard.press('Escape');
  const wed = card(page, '2026-10-28 Wednesday');
  await expect(wed).toBeVisible();
  await expect(wed).toContainText('GPU memory optimization');
  const [m, t, w] = [await card(page, 'Monday').boundingBox(), await tue.boundingBox(), await wed.boundingBox()];
  expect(Math.round(w!.y)).toBe(Math.round(t!.y));                                   // same row
  expect(Math.round(w!.width)).toBe(Math.round(t!.width));                           // same size
  expect(Math.round(w!.x - (t!.x + t!.width))).toBe(Math.round(t!.x - (m!.x + m!.width)));   // same gap
  expect(errors).toEqual([]);
});

test('a card casts no shadow, at rest or in hand; in hand it keeps its ring and nothing of it fades', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'Lift me');
  await clickAway(page);
  expect(await c.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
  await select(page, c);
  const b = (await c.boundingBox())!;
  await page.mouse.move(b.x + 30, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 130, b.y + 120, { steps: 8 });
  const shadow = await page.locator('#world .node.dragging').first().evaluate(el => getComputedStyle(el).boxShadow);
  expect(shadow).toContain('rgb(13, 153, 255) 0px 0px 0px 2px');   // the selection ring
  expect(shadow).not.toContain('rgba(0, 0, 0');                      // no lift
  expect(await page.locator('#dragLayer').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
  await expect(page.locator('#floatBar')).toHaveClass(/hide-interact/);
  await page.mouse.up();
});

test('a card is never opened: only a section has an inside', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Note\nsome text');
  await select(page, c);
  await expect(page.locator('#fbOpen')).toBeHidden();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await expect(page.locator('body')).not.toHaveClass(/scoped/);
  await expect(c).toBeVisible();
});

test('a table in a narrow card wraps between words: a short column never breaks inside a word', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300,
    '# Costs\n\n| # | Item | Cost |\n|---|---|---|\n| A10 | Bindings and locks: values link to presets, variables or tokens | M–H |');
  const lines = (sel: string) => c.locator(sel).evaluate(el => {
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    const r = document.createRange();
    r.selectNodeContents(el);
    return Math.round(r.getBoundingClientRect().height / lh);
  });
  await settled(page);   // the card has painted at its final width
  expect(await lines('tbody td:first-child')).toBe(1);   // `A10`, not `A` / `10`
  expect(await lines('thead th:last-child')).toBe(1);    // `Cost`, not `Co` / `st`
});

test('undo and redo say what they took back', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Groceries\nmilk');
  await select(page, c);
  await page.keyboard.press('Backspace');
  await expect(card(page, 'Groceries')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#status')).toHaveText('Undo: Deleted “Groceries”');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('#status')).toHaveText('Redo: Deleted “Groceries”');
});

// What a card's note takes dropped into it has ONE rule (utils/model.ts takesDrop): a plain, unlocked card.
// An image card IS its picture, so a card ⌥-dropped on it is not folded in — it lands on the board.
test('⌥-dropping a card merges it into a plain card, never into an image card', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="red"/></svg>');
  await seedBoard(page, {
    'One.md': note('# One'),
    'Two.md': note('# Two'),
    'Target.md': note('# Target'),
    'Pic.md': note(`![pic](data:image/svg+xml;base64,${svg.toString('base64')})`),
    'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 }, edges: [], nodes: {
      'One.md': { x: 0, y: 0, w: 200 }, 'Two.md': { x: 0, y: 260, w: 200 },
      'Target.md': { x: 400, y: 0, w: 200 }, 'Pic.md': { x: 400, y: 260, w: 200, h: 150 } } }),
  });
  const altDrop = async (what: string, onto: Locator): Promise<void> => {
    const from = await centre(card(page, what)), to = await centre(onto);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 30, from.y + 10, { steps: 3 });
    await page.keyboard.down('Alt');   // ⌥ is pressed with the card already in hand
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await settled(page);   // the drop target is settled on the frame after the last move
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await settled(page);
  };
  await altDrop('One', card(page, 'Target'));
  await expect(page.locator('#world .node')).toHaveCount(3);           // One went into Target
  await expect(card(page, 'Target')).toContainText('One');
  const pic = page.locator('#world .node.image-card');
  await altDrop('Two', pic);
  await expect(page.locator('#world .node')).toHaveCount(3);           // Two is still its own card
  await expect(pic).toHaveCount(1);
  await expect(pic.locator('img.md-img')).toBeVisible();
  expect(errors).toEqual([]);
});
