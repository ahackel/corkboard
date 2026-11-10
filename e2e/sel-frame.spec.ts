import { test, expect } from '@playwright/test';
import { openBoard, makeCard, select, seedBoard, note, section, card, settled } from './helpers';

test('a multi-selection wears ONE frame round all of it, and its corner scales the lot', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 300, 'Left');
  const b = await makeCard(page, 600, 300, 'Right');
  const frame = page.locator('#selFrame');
  await select(page, a);
  await expect(frame).toBeHidden();
  await b.click({ modifiers: ['ControlOrMeta'] });
  await expect(frame).toBeVisible();
  const ar0 = (await a.boundingBox())!, br0 = (await b.boundingBox())!;
  const f0 = (await frame.boundingBox())!;
  expect(Math.abs(f0.x - ar0.x)).toBeLessThan(1);
  expect(Math.abs(f0.x + f0.width - (br0.x + br0.width))).toBeLessThan(1);

  // drag the bottom-right handle out: both cards widen, and the right one moves right, the left one stays
  const h = (await frame.locator('.sf-se').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 200, h.y + h.height / 2 + 100, { steps: 6 });
  await page.mouse.up();
  const ar = (await a.boundingBox())!, br = (await b.boundingBox())!;
  expect(Math.abs(ar.x - ar0.x)).toBeLessThan(1);
  expect(ar.width).toBeGreaterThan(ar0.width + 20);
  expect(br.x).toBeGreaterThan(br0.x + 20);
  expect(br.height).toBeGreaterThan(br0.height + 20);
  const f = (await frame.boundingBox())!;
  expect(Math.abs(f.x + f.width - (br.x + br.width))).toBeLessThan(1);

  // one undo puts both back
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => Math.round((await b.boundingBox())!.x)).toBe(Math.round(br0.x));
  expect(Math.round((await a.boundingBox())!.width)).toBe(Math.round(ar0.width));
});

test('scaling a section with the frame scales what is inside it; a folded pill only rides along', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, {
    'Todo.md': note('# Todo', { 'mm_type': 'frame' }),
    'Milk.md': note('Buy milk', { 'mm_parent': 'Todo.md' }),
    'Loose.md': note('A loose card'),
    'Old.md': note('# Old', { 'mm_type': 'frame', 'mm_collapsed': 'true' }),
    'board.json': JSON.stringify({ version: 1, model: 2, edges: [], nodes: {
      'Todo.md': { x: 0, y: 0, w: 300, h: 240 }, 'Milk.md': { x: 40, y: 60 },
      'Loose.md': { x: 400, y: 0 }, 'Old.md': { x: 400, y: 300, collapsed: true } } }),
  });
  const todo = section(page, 'Todo'), milk = card(page, 'Buy milk');
  const old = page.locator('#world .node.section-folded', { hasText: 'Old' });
  await select(page, card(page, 'A loose card'));
  await todo.locator(':scope > .title-row').click({ modifiers: ['ControlOrMeta'] });
  await old.click({ modifiers: ['ControlOrMeta'] });
  await settled(page);
  const t0 = (await todo.boundingBox())!, m0 = (await milk.boundingBox())!, o0 = (await old.boundingBox())!;
  const h = (await page.locator('#selFrame .sf-se').boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 300, h.y + h.height / 2 + 200, { steps: 6 });
  await page.mouse.up();
  await settled(page);
  const t = (await todo.boundingBox())!, m = (await milk.boundingBox())!, o = (await old.boundingBox())!;
  expect(t.width).toBeGreaterThan(t0.width + 50);
  expect(m.x - t.x).toBeGreaterThan(m0.x - t0.x + 5);   // the card inside spread with its box
  expect(m.width).toBeGreaterThan(m0.width + 20);
  expect(Math.abs(o.width - o0.width)).toBeLessThan(1);   // the pill keeps its size…
  expect(o.x).toBeGreaterThan(o0.x + 50);                  // …and moves
});

test('the frame\'s empty interior drags the whole selection, and a click there keeps it', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 300, 'Left');
  const b = await makeCard(page, 700, 300, 'Right');
  await select(page, a);
  await b.click({ modifiers: ['ControlOrMeta'] });
  const ar0 = (await a.boundingBox())!, br0 = (await b.boundingBox())!;
  const gap = { x: (ar0.x + ar0.width + br0.x) / 2, y: ar0.y + ar0.height / 2 };
  await page.mouse.click(gap.x, gap.y);
  await settled(page);
  await expect(page.locator('#world .node.sel')).toHaveCount(2);
  await page.mouse.move(gap.x, gap.y);
  await page.mouse.down();
  await page.mouse.move(gap.x + 120, gap.y + 80, { steps: 8 });
  await page.mouse.up();
  await settled(page);
  const ar = (await a.boundingBox())!, br = (await b.boundingBox())!;
  expect(ar.x - ar0.x).toBeGreaterThan(80);
  expect(Math.abs((br.x - br0.x) - (ar.x - ar0.x))).toBeLessThan(1);   // moved as one piece
  expect(Math.abs((br.y - br0.y) - (ar.y - ar0.y))).toBeLessThan(1);
  await expect(page.locator('#world .node.sel')).toHaveCount(2);
});

test('the frame\'s edges scale the selection along one axis — in a gap, and on a member\'s own edge', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 300, 'Top');
  const b = await makeCard(page, 700, 500, 'Bottom');
  await select(page, a);
  await b.click({ modifiers: ['ControlOrMeta'] });
  const frame = page.locator('#selFrame .sf-box');
  const ar0 = (await a.boundingBox())!, br0 = (await b.boundingBox())!;

  // the frame's right edge, level with the top card — nothing but the gap is there
  const f0 = (await frame.boundingBox())!;
  await page.mouse.move(f0.x + f0.width, ar0.y + ar0.height / 2);
  await page.mouse.down();
  await page.mouse.move(f0.x + f0.width + 200, ar0.y + ar0.height / 2, { steps: 6 });
  await page.mouse.up();
  await settled(page);
  const ar1 = (await a.boundingBox())!, br1 = (await b.boundingBox())!;
  expect(Math.abs(ar1.x - ar0.x)).toBeLessThan(1);           // the left side held
  expect(ar1.width).toBeGreaterThan(ar0.width + 20);         // both widened…
  expect(br1.x).toBeGreaterThan(br0.x + 50);                 // …and spread apart
  expect(Math.abs(ar1.height - ar0.height)).toBeLessThan(1); // heights untouched
  expect(Math.abs(br1.y - br0.y)).toBeLessThan(1);

  // the bottom card's own bottom edge is the frame's: it scales both, the top one held at the top
  const e = (await b.locator(':scope > .fh-s').boundingBox())!;
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2 + 150, { steps: 6 });
  await page.mouse.up();
  await settled(page);
  const ar2 = (await a.boundingBox())!, br2 = (await b.boundingBox())!;
  expect(Math.abs(ar2.y - ar1.y)).toBeLessThan(1);
  expect(ar2.height).toBeGreaterThan(ar1.height + 20);
  expect(br2.y).toBeGreaterThan(br1.y + 30);
  await expect(page.locator('#world .node.sel')).toHaveCount(2);
});
