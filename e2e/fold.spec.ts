import { test, expect } from '@playwright/test';
import { openBoard, makeCard, palette, reload, clickAway, card, watchErrors } from './helpers';

test('the arrow folds a card to its first line and says how much it hides', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const g = await makeCard(page, 300, 250, '# Groceries\nmilk\neggs\nbread');
  const one = await makeCard(page, 650, 250, 'One line only');
  await expect(one).not.toHaveAttribute('data-chip');   // nothing to fold away, so no arrow
  await g.hover();
  await g.locator('.hidden-count').click();
  await expect(g).toHaveClass(/collapsed/);
  await expect(g.locator('.fold-more')).toHaveText('3 more lines');
  await expect(g).not.toContainText('eggs');
  await reload(page);
  await expect(card(page, 'Groceries')).toHaveClass(/collapsed/);
  expect(errors).toEqual([]);
});

test('resting the mouse on a folded card peeks at the whole note', async ({ page }) => {
  await openBoard(page);
  const g = await makeCard(page, 300, 250, '# Groceries\nmilk\neggs');
  await g.hover();
  await g.locator('.hidden-count').click();
  await clickAway(page);
  const b = (await g.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await expect(page.locator('#peek.open')).toContainText('eggs');
  await page.mouse.move(1180, 700);
  await expect(page.locator('#peek.open')).toHaveCount(0);
  await expect(g).toHaveClass(/collapsed/);   // reading changed nothing
});

test('⌘K collapses and expands every card; ⌥-click folds the cards beside one', async ({ page }) => {
  await openBoard(page);
  const a = await makeCard(page, 300, 200, '# A\none\ntwo');
  await makeCard(page, 300, 420, '# B\none\ntwo');
  await makeCard(page, 650, 200, '# C\none\ntwo');
  await palette(page, 'Collapse all cards');
  await expect(page.locator('#world .node.collapsed')).toHaveCount(3);
  await palette(page, 'Expand all cards');
  await expect(page.locator('#world .node.collapsed')).toHaveCount(0);
  await a.hover();
  await a.locator('.hidden-count').click({ modifiers: ['Alt'] });
  await expect(page.locator('#world .node.collapsed')).toHaveCount(3);
});

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });   // a tablet, in Chromium
  test('tapping "N more lines" peeks', async ({ page }) => {
    await openBoard(page);
    await page.mouse.dblclick(300, 300);
    await page.keyboard.type('# Groceries\nmilk\neggs');
    await page.mouse.click(700, 60);
    const g = card(page, 'Groceries');
    await g.tap();
    await g.locator('.hidden-count').tap();
    await expect(g).toHaveClass(/collapsed/);
    await g.locator('.fold-more').tap();
    await expect(page.locator('#peek.open')).toContainText('eggs');
  });
});
