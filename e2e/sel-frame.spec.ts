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
