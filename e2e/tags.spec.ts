// Tags are Obsidian's: frontmatter `tags:` plus `#tags` in the text. `#` adds and removes them, a click on
// one filters the board by it (features/tags.ts, tag-picker.ts, tag-filter.ts).
import { test, expect } from '@playwright/test';
import { openBoard, seedBoard, note, card, select, clickAway, diskFiles, watchErrors, palette } from './helpers';

const BOARD = {
  'Login.md': note('# Fix login\nSessions drop. Try #idea', { tags: '[🔥, backend]' }),
  'Offsite.md': note('# Plan offsite', { tags: '[🔥, people]' }),
  'Logo.md': note('# Logo ideas'),
  'board.json': JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 }, edges: [], nodes: {
    'Login.md': { x: 0, y: 0, w: 200 }, 'Offsite.md': { x: 260, y: 0, w: 200 }, 'Logo.md': { x: 520, y: 0, w: 200 } } }),
};

test('a card wears its tags on its top edge: emoji as stamps, words as labels, the text’s dashed', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const login = card(page, 'Fix login');
  await expect(login.locator('.tag.stamp')).toHaveText('🔥');
  await expect(login.locator('.tag.label:not(.in-text)')).toHaveText('#backend');
  await expect(login.locator('.tag.in-text')).toHaveText('#idea');
  await expect(login.locator('.body .md-tag')).toHaveText('#idea');
  // on the top edge, not hanging below
  const c = (await login.boundingBox())!, t = (await login.locator('.tag.stamp').boundingBox())!;
  expect(t.y).toBeLessThan(c.y);
  await expect(card(page, 'Logo ideas').locator('.tag')).toHaveCount(0);
  // no add button on a selected card any more
  await select(page, login);
  await expect(page.locator('.tag-add-btn')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('# tags the selection — by an emoji’s name or a new word — and unticking removes it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const logo = card(page, 'Logo ideas');
  await select(page, logo);
  await page.keyboard.press('#');
  const pop = page.locator('#tagPop');
  await expect(pop).toBeVisible();
  await page.keyboard.type('sta');
  await expect(pop.locator('.tp-row.active')).toContainText('star');
  await page.keyboard.press('Enter');
  await page.keyboard.type('design');
  await expect(pop.locator('.tp-row.active')).toContainText('new tag');
  await page.keyboard.press('Enter');
  await expect(logo.locator('.tag')).toHaveText(['⭐', '#design']);
  let files = await diskFiles(page);
  expect(files['Logo ideas.md']).toContain('tags: [⭐, design]');
  // the card's own tags are listed ticked: untick one
  await pop.locator('.tp-row.ticked', { hasText: 'design' }).click();
  await expect(logo.locator('.tag')).toHaveText(['⭐']);
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  files = await diskFiles(page);
  expect(files['Logo ideas.md']).toContain('tags: [⭐]');
  expect(errors).toEqual([]);
});

test('a click on a tag filters the board by it; more narrow it; Esc clears', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await clickAway(page);
  await card(page, 'Fix login').locator('.tag.stamp').click();
  const bar = page.locator('#tagFilterBar');
  await expect(bar).toContainText('2 cards');
  await expect(card(page, 'Logo ideas')).toHaveClass(/search-dim/);
  await expect(card(page, 'Plan offsite')).not.toHaveClass(/search-dim/);
  await card(page, 'Plan offsite').locator('.tag', { hasText: '#people' }).click();
  await expect(bar).toContainText('1 card');
  await expect(card(page, 'Fix login')).toHaveClass(/search-dim/);
  // nothing was changed by it
  expect(Object.values(await diskFiles(page)).find(t => t.includes('Fix login'))).toContain('tags: [🔥, backend]');
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(page.locator('#world .node.search-dim')).toHaveCount(0);
  // the palette's way in, over the board's tags — including one only written in a note's text
  await palette(page, 'Filter by tag');
  await page.keyboard.type('idea');
  await page.keyboard.press('Enter');
  await expect(bar).toContainText('1 card');
  await expect(card(page, 'Plan offsite')).toHaveClass(/search-dim/);
  expect(errors).toEqual([]);
});

test('a folded frame says how many of its cards match the filter', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, {
    'Loose.md': note('# Loose', { tags: '[🔥]' }),
    'Box/_index.md': note('# Box', { mm_type: 'frame' }),
    'Box/A.md': note('# A', { tags: '[🔥]' }),
    'Box/B.md': note('# B'),
    'board.json': JSON.stringify({ version: 1, model: 2, settings: {}, edges: [], nodes: {
      'Loose.md': { x: 0, y: 300 }, 'Box/_index.md': { x: 0, y: 0, w: 300, h: 240 },
      'Box/A.md': { x: 20, y: 40 }, 'Box/B.md': { x: 20, y: 140 } } }),
  });
  // read while unfolded, then folded
  await page.locator('#world .node.frame', { hasText: 'Box' }).locator(':scope > .title-row').click();
  await page.keyboard.press('x');
  await card(page, 'Loose').locator('.tag').click();
  await expect(page.locator('#tagFilterBar')).toContainText('2 cards');
  await expect(page.locator('#world .node.frame-folded .frame-hits')).toHaveText('1 match');
});
