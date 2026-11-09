import { test, expect } from '@playwright/test';
import { openBoard, seedBoard, note, card, watchErrors, settled, diskFiles, reload } from './helpers';

// A note written in Obsidian: a picture embedded by NAME (it lives in a section's folder, not beside the
// note), and a short link to a note in that folder, pointing at a heading in it.
const PIC = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>';
const BOARD = {
  'Start.md': note('# Start\nSee [[Plan#Goals]]\n\n![[pic.svg|30]]'),
  'Ideas/_index.md': note('# Ideas'),
  'Ideas/Plan.md': note('# Plan\n## Goals\nShip it'),
  'Ideas/pic.svg': PIC,
};

test('an Obsidian embed finds its picture by name, and a short link goes to the note in its folder', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const start = card(page, 'See Plan#Goals');
  const img = start.locator('img.md-img');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect(img).not.toHaveClass(/md-img-missing/);
  // the folder isn't read yet (the section is folded): following the link reads it, and goes there
  await start.locator('a.wikilink').click();
  await expect(card(page, 'Ship it')).toBeVisible();
  await settled(page);
  const files = await diskFiles(page);
  expect(Object.keys(files).filter(f => f.endsWith('.md')).sort()).toEqual(['Ideas/Plan.md', 'Ideas/_index.md', 'Start.md']);
  expect(errors).toEqual([]);
});

test('renaming a note in a folder keeps a short link to it pointing at it', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, { ...BOARD, 'board.json': JSON.stringify({ version: 1, model: 2, nodes: {
    'Start.md': { x: 0, y: 0 }, 'Ideas/_index.md': { x: 400, y: 0, w: 320, h: 300 }, 'Ideas/Plan.md': { x: 420, y: 40 } } }) });
  const plan = card(page, 'Ship it');
  await plan.dblclick();
  await expect(page.locator('textarea.body-edit')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.insertText('# Roadmap');
  await page.keyboard.press('Escape');
  await reload(page);
  const files = await diskFiles(page);
  expect(files['Ideas/Roadmap.md']).toBeDefined();
  expect(files['Start.md']).toContain('[[Roadmap#Goals]]');
});
