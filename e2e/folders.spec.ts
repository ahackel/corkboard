// A frame is a FOLDER on disk (`<Name>/_index.md` plus its cards), and a folded frame's notes are not
// read until it is unfolded (data/lazy.ts).
import { test, expect } from '@playwright/test';
import { openBoard, seedBoard, note, frame, card, reload, watchErrors, diskFiles, palette } from './helpers';

// The flat, pre-folder format: the parent named in mm_parent.
const LEGACY = {
  'Todo.md': note('# Todo', { 'mm_type': 'frame' }),
  'Milk.md': note('Buy milk', { 'mm_parent': 'Todo.md' }),
  'Loose.md': note('A loose card'),
  'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 },
    edges: [{ id: 'e1', from: 'Loose.md', to: 'Milk.md' }], nodes: {
    'Todo.md': { x: 0, y: 0, w: 300, h: 240 }, 'Milk.md': { x: 40, y: 60 }, 'Loose.md': { x: 0, y: 420 } } }),
};

test('an old flat map moves into folders: a frame becomes its folder, its cards go inside', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, LEGACY);
  const files = await diskFiles(page);
  // (each file is named off its text, as always: `Milk.md` holds "Buy milk")
  expect(Object.keys(files).sort()).toEqual(['A loose card.md', 'Todo/Buy milk.md', 'Todo/_index.md']);
  expect(files['Todo/Buy milk.md']).not.toContain('mm_parent');
  await reload(page);
  await expect(frame(page, 'Todo')).toBeVisible();
  await expect(card(page, 'Buy milk')).toBeVisible();
  await expect(page.locator('#freeEdges path.fe')).toHaveCount(1);   // the line followed the move
  expect(errors).toEqual([]);
});

// A map already in folders, with one frame saved folded.
const FOLDERS = {
  'Loose.md': note('A loose card'),
  'Box/_index.md': note('# Box', { 'mm_type': 'frame' }),
  'Box/One.md': note('First inside'),
  'Box/Two.md': note('Second inside'),
  'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 },
    edges: [{ id: 'e1', from: 'Loose.md', to: 'Box/One.md' }], nodes: {
    'Loose.md': { x: 0, y: 420 }, 'Box/_index.md': { x: 0, y: 0, w: 300, h: 300, collapsed: true },
    'Box/One.md': { x: 40, y: 60 }, 'Box/Two.md': { x: 40, y: 160 } } }),
};

test('a folded frame is not read until it unfolds, and lets go of its notes when folded again', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, FOLDERS);
  const pill = page.locator('#world .node.frame-folded', { hasText: 'Box' });
  await expect(pill.locator('.frame-count')).toHaveText('2');          // counted, not read
  await expect(page.locator('#world .node', { hasText: 'First inside' })).toHaveCount(0);
  await expect(page.locator('#freeEdges path.fe')).toHaveCount(1);     // its line still meets the pill
  await pill.dblclick();
  await expect(card(page, 'First inside')).toBeVisible();
  await expect(card(page, 'Second inside')).toBeVisible();
  // fold it again: once saved, its notes leave memory (and the DOM) again
  await frame(page, 'Box').locator(':scope > .title-row').click();
  await page.locator('#fbFold').click();
  await page.waitForTimeout(1500);
  await expect(page.locator('#world .node', { hasText: 'First inside' })).toHaveCount(0);
  await expect(page.locator('#world .node.frame-folded .frame-count')).toHaveText('2');
  await expect(page.locator('#freeEdges path.fe')).toHaveCount(1);
  // ⌘Z unfolds it again — and its notes, already let go of, are read back in
  await page.keyboard.press('ControlOrMeta+z');
  await expect(card(page, 'First inside')).toBeVisible();
  await reload(page);
  await expect(page.locator('#freeEdges path.fe')).toHaveCount(1);     // the line survived it all
  expect(errors).toEqual([]);
});

test('a folder made outside the app arrives as a folded frame named after it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, { 'Loose.md': note('A loose card'), 'Inbox/From phone.md': note('Call Sam') });
  const pill = page.locator('#world .node.frame-folded', { hasText: 'Inbox' });
  await expect(pill.locator('.frame-count')).toHaveText('1');
  await palette(page, 'Expand all');
  await expect(card(page, 'Call Sam')).toBeVisible();
  const files = await diskFiles(page);
  expect(files['Inbox/_index.md']).toContain('# Inbox');            // it is an ordinary frame now
  expect(files['Inbox/Call Sam.md']).toContain('Call Sam');          // named off its text, like every note
  expect(errors).toEqual([]);
});

test('renaming a frame renames its folder and moves its notes, read or not', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, FOLDERS);
  // the folded pill: select it, rename it through its label
  const pill = page.locator('#world .node.frame-folded', { hasText: 'Box' });
  await pill.click();
  await page.keyboard.press('F2');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Crate');
  await page.keyboard.press('Enter');
  const files = await diskFiles(page);
  expect(Object.keys(files).sort()).toEqual(['A loose card.md', 'Crate/First inside.md', 'Crate/Second inside.md', 'Crate/_index.md']);
  await reload(page);
  await expect(page.locator('#freeEdges path.fe')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('opening a folded frame and leaving it again keeps it folded, where it was', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, FOLDERS);
  const pill = page.locator('#world .node.frame-folded', { hasText: 'Box' });
  const before = (await pill.boundingBox())!;
  const atRest = async () => { const b = (await pill.boundingBox())!; return [Math.round(b.x), Math.round(b.y)]; };
  await pill.click();
  await page.keyboard.press('ArrowUp');                              // go in
  await expect(card(page, 'First inside')).toBeVisible();
  await page.keyboard.press('ArrowDown');                            // and out
  await page.waitForTimeout(700);
  await expect(pill).toBeVisible();
  await expect(card(page, 'First inside')).toBeHidden();
  // the camera glides back to where it was, so the pill is exactly where it was on screen
  expect(await atRest()).toEqual([Math.round(before.x), Math.round(before.y)]);
  await reload(page);
  const again = page.locator('#world .node.frame-folded', { hasText: 'Box' });
  await expect(again).toBeVisible();                                 // still folded on disk
  expect(errors).toEqual([]);
});

test('unfolding a frame does not glide its cards: they appear where they sit', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, FOLDERS);
  await page.locator('#world .node.frame-folded', { hasText: 'Box' }).dblclick();
  const one = card(page, 'First inside');
  await expect(one).toBeVisible();
  const early = (await one.boundingBox())!;                          // mid-animation
  await page.waitForTimeout(700);
  const late = (await one.boundingBox())!;
  expect([Math.round(early.x), Math.round(early.y)]).toEqual([Math.round(late.x), Math.round(late.y)]);
});

test('a frame clips its cards all the way through an unfold', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, FOLDERS);
  await page.locator('#world .node.frame-folded', { hasText: 'Box' }).dblclick();
  await expect(card(page, 'First inside')).toBeVisible();
  await page.waitForTimeout(120);                                    // mid-animation
  const [box, clip] = await page.evaluate(() => {
    const f = [...document.querySelectorAll<HTMLElement>('#world .node.frame')].find(e => e.textContent?.includes('Box'))!;
    const r = (e: Element) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
    return [r(f), r(document.querySelector('#world .frame-content')!)];
  });
  expect(box[2] - box[0]).toBeLessThan(290);                         // still growing (it opens to 300)
  expect(clip[0]).toBeGreaterThanOrEqual(box[0] - 1);
  expect(clip[1]).toBeGreaterThanOrEqual(box[1] - 1);
  expect(clip[2]).toBeLessThanOrEqual(box[2] + 1);
  expect(clip[3]).toBeLessThanOrEqual(box[3] + 1);
});
