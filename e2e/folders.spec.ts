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
