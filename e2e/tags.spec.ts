// Tags are Obsidian's: frontmatter `tags:` plus `#tags` in the text. `#` adds and removes them, a click on
// one filters the board by it (features/tags.ts, tag-picker.ts, tag-filter.ts).
import { test, expect } from '@playwright/test';
import { openBoard, seedBoard, note, card, select, clickAway, diskFiles, watchErrors } from './helpers';

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

test('a click on a tag searches by it; more narrow it; Esc ends the search', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await clickAway(page);
  await card(page, 'Fix login').locator('.tag.stamp').click();
  const chips = page.locator('#searchChips .sc-tag');
  await expect(chips).toHaveText(['🔥✕']);
  await expect(card(page, 'Logo ideas')).toHaveClass(/search-dim/);
  await expect(card(page, 'Plan offsite')).not.toHaveClass(/search-dim/);
  await card(page, 'Plan offsite').locator('.tag', { hasText: '#people' }).click();
  await expect(chips).toHaveCount(2);
  await expect(card(page, 'Fix login')).toHaveClass(/search-dim/);
  // nothing was changed by it
  expect(Object.values(await diskFiles(page)).find(t => t.includes('Fix login'))).toContain('tags: [🔥, backend]');
  await page.keyboard.press('Escape');
  await expect(page.locator('#searchWrap')).toBeHidden();
  await expect(page.locator('#world .node.search-dim')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('one field finds by text and #tags: # suggests the board’s tags, Backspace takes a chip back', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await clickAway(page);
  await page.keyboard.press('Control+f');
  await expect(page.locator('#searchBox')).toBeFocused();
  await page.keyboard.type('#ide');   // a tag only written in a note's text is on the board too
  await expect(page.locator('#searchResults .sr-tag.active')).toContainText('#idea');
  await page.keyboard.press('Enter');
  await expect(page.locator('#searchChips .sc-tag')).toHaveCount(1);
  await expect(page.locator('#searchResults .sr-count')).toHaveText('1 card');
  await expect(card(page, 'Plan offsite')).toHaveClass(/search-dim/);
  await page.keyboard.press('Backspace');
  await expect(page.locator('#searchChips .sc-tag')).toHaveCount(0);
  await page.keyboard.type('#🔥 offsite');   // a space after a #word makes the chip
  await expect(page.locator('#searchChips .sc-tag')).toHaveCount(1);
  await expect(page.locator('#searchResults .sr-count')).toHaveText('1 card');
  await expect(card(page, 'Fix login')).toHaveClass(/search-dim/);
  // a search with something in it stays while you work under it
  await card(page, 'Plan offsite').click();
  await expect(page.locator('#searchWrap')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the tag tray: T shows it, a sticker dragged onto a card tags it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await clickAway(page);
  await page.keyboard.press('t');
  const tray = page.locator('#tagTray');
  await expect(tray).toBeVisible();
  await expect(page.locator('#trayBtn')).toHaveAttribute('aria-pressed', 'true');
  // a new sticker, made in the tray
  await tray.locator('.tray-new').fill('urgent');
  await tray.locator('.tray-new').press('Enter');
  const sticker = tray.locator('.tag', { hasText: '#urgent' });
  await expect(sticker).toBeVisible();
  await drag(page, sticker, card(page, 'Logo ideas'));
  await expect(card(page, 'Logo ideas').locator('.tag')).toHaveText(['#urgent']);
  expect(Object.values(await diskFiles(page)).find(t => t.includes('Logo ideas'))).toContain('tags: [urgent]');
  // the dock button puts it away
  await page.locator('#trayBtn').click();
  await expect(tray).toBeHidden();
  expect(errors).toEqual([]);
});

test('a tag dragged to another card moves there; dragged off onto the canvas it goes', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await clickAway(page);
  await drag(page, card(page, 'Fix login').locator('.tag', { hasText: '#backend' }), card(page, 'Logo ideas'));
  await expect(card(page, 'Logo ideas').locator('.tag')).toHaveText(['#backend']);
  await expect(card(page, 'Fix login').locator('.tag:not(.in-text)')).toHaveText(['🔥']);
  // ⌘Z puts it back in one step
  await page.keyboard.press('Control+z');
  await expect(card(page, 'Logo ideas').locator('.tag')).toHaveCount(0);
  await expect(card(page, 'Fix login').locator('.tag', { hasText: '#backend' })).toBeVisible();
  // off onto the bare canvas: gone
  const stamp = card(page, 'Plan offsite').locator('.tag.stamp');
  const b = (await stamp.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + 300, { steps: 8 });
  await page.mouse.up();
  await expect(card(page, 'Plan offsite').locator('.tag')).toHaveText(['#people']);
  expect(Object.values(await diskFiles(page)).find(t => t.includes('Plan offsite'))).toContain('tags: [people]');
  expect(errors).toEqual([]);
});

test('⇧-dragging a tag to another card copies it, as ⇧-drag clones a card', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, BOARD);
  await clickAway(page);
  await page.keyboard.down('Shift');
  await drag(page, card(page, 'Fix login').locator('.tag', { hasText: '#backend' }), card(page, 'Logo ideas'));
  await page.keyboard.up('Shift');
  await expect(card(page, 'Logo ideas').locator('.tag')).toHaveText(['#backend']);
  await expect(card(page, 'Fix login').locator('.tag', { hasText: '#backend' })).toBeVisible();
});

test('the tray makes an emoji sticker from its name; a sticker dragged off deletes the tag everywhere, after asking', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await clickAway(page);
  await page.keyboard.press('t');
  const tray = page.locator('#tagTray');
  await tray.locator('.tray-new').fill('rocket');
  await expect(tray.locator('.tray-suggest .tp-row.active')).toContainText('🚀');
  await tray.locator('.tray-new').press('Enter');
  const rocket = tray.locator('.tag', { hasText: '🚀' });
  await expect(rocket).toBeVisible();
  // unused: it just goes
  await dragOff(page, rocket);
  await expect(tray.locator('.tag', { hasText: '🚀' })).toHaveCount(0);
  // used by two cards: asked, then gone from both
  let asked = '';
  page.once('dialog', d => { asked = d.message(); void d.accept(); });
  await dragOff(page, tray.locator('.tag', { hasText: '🔥' }));
  expect(asked).toContain('from 2 cards');
  await expect(page.locator('#world .node .tag', { hasText: '🔥' })).toHaveCount(0);
  await expect(tray.locator('.tag', { hasText: '🔥' })).toHaveCount(0);
  // declined: nothing happens
  page.once('dialog', d => void d.dismiss());
  await dragOff(page, tray.locator('.tag', { hasText: '#people' }));
  await expect(card(page, 'Plan offsite').locator('.tag', { hasText: '#people' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a folded frame says how many of its cards match the search', async ({ page }) => {
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
  await expect(page.locator('#world .node.frame-folded .frame-hits')).toHaveText('1 match');
  await expect(page.locator('#world .node.frame-folded')).not.toHaveClass(/search-dim/);
});

// Carry a sticker up off the tray onto the bare board, and let go.
async function dragOff(page: import('@playwright/test').Page, from: import('@playwright/test').Locator): Promise<void> {
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, 200, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

// Press on `from`, carry it over `to`, let go — the way a person drags a sticker.
async function drag(page: import('@playwright/test').Page, from: import('@playwright/test').Locator, to: import('@playwright/test').Locator): Promise<void> {
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}
