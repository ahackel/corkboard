import { test, expect } from '@playwright/test';
import { openBoard, makeCard, palette, reload, clickAway, card, select, watchErrors } from './helpers';

test('the arrow folds a card to a one-line chip that says how much it hides', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const g = await makeCard(page, 300, 250, '# Groceries\nmilk\neggs\nbread');
  const one = await makeCard(page, 650, 250, 'One line only');
  await expect(page.locator('#world .hidden-count')).toHaveCount(0);   // no fold button on cards any more
  await select(page, one);
  await expect(page.locator('#fbFold')).toBeHidden();           // nothing to fold away
  await select(page, g);
  await expect(page.locator('#fbFold')).toHaveAttribute('title', 'Collapse (X)');
  await page.locator('#fbFold').click();
  await expect(g).toHaveClass(/collapsed/);
  await expect(page.locator('#fbFold')).toHaveAttribute('title', 'Expand (X)');
  await expect(g.locator('.fold-more')).toHaveText('+3');
  await expect(g.locator('.fold-more')).toHaveAttribute('title', '3 more lines');
  expect((await g.boundingBox())!.width).toBeLessThan(200);   // shrink-wrapped to its line
  await g.dblclick();                                           // a double-click unfolds it
  await expect(g).not.toHaveClass(/collapsed/);
  await page.keyboard.press('x');
  await expect(g).not.toContainText('eggs');
  await reload(page);
  await expect(card(page, 'Groceries')).toHaveClass(/collapsed/);
  expect(errors).toEqual([]);
});

test('resting the mouse on a folded card peeks at the whole note', async ({ page }) => {
  await openBoard(page);
  const g = await makeCard(page, 300, 250, '# Groceries\nmilk\neggs');
  await select(page, g);
  await page.keyboard.press('x');
  await clickAway(page);
  const b = (await g.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await expect(page.locator('#peek.open')).toContainText('eggs');
  await page.mouse.move(1180, 700);
  await expect(page.locator('#peek.open')).toHaveCount(0);
  await expect(g).toHaveClass(/collapsed/);   // reading changed nothing
});

test('⌘K collapses and expands every card and frame', async ({ page }) => {
  await openBoard(page);
  await makeCard(page, 300, 200, '# A\none\ntwo');
  await makeCard(page, 300, 420, '# B\none\ntwo');
  await makeCard(page, 650, 200, '# C\none\ntwo');
  await palette(page, 'Collapse all');
  await expect(page.locator('#world .node.collapsed')).toHaveCount(3);
  await palette(page, 'Expand all');
  await expect(page.locator('#world .node.collapsed')).toHaveCount(0);
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
    await page.locator('#fbFold').tap();
    await expect(g).toHaveClass(/collapsed/);
    await g.locator('.fold-more').tap();
    await expect(page.locator('#peek.open')).toContainText('eggs');
  });
});

test('a checklist card wears its progress, and folded its chip says it', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 300, 250, '# Trip\n- [x] tickets\n- [ ] hotel\n- [ ] bags');
  const meter = c.locator('.task-meter');
  await expect(meter).toHaveText('1/3');
  await expect(meter).toHaveAttribute('title', '1 of 3 tasks done (33%)');
  await c.locator('.taskbox').nth(1).click();
  await expect(meter).toHaveText('2/3');
  await select(page, c);
  await page.locator('#fbFold').click();
  await expect(c).toHaveClass(/collapsed/);
  await expect(meter).toBeHidden();
  await expect(c.locator('.fold-more')).toHaveText('2/3');
  const plain = await makeCard(page, 650, 250, 'No tasks here');
  await expect(plain.locator('.task-meter')).toBeHidden();
});

test('folding and Fit animate the size instead of jumping', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Groceries\nmilk\neggs\nbread');
  await select(page, c);
  const running = () => c.evaluate(el => el.getAnimations().length);
  await page.locator('#fbFold').click();
  expect(await running()).toBeGreaterThan(0);
  await page.waitForTimeout(650);
  expect(await running()).toBe(0);
  await page.locator('#fbFold').click();                       // expand
  await page.waitForTimeout(650);
  const s = (await c.locator(':scope > .fh-s').boundingBox())!;  // drag it taller, then Fit
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down(); await page.mouse.move(s.x + s.width / 2, s.y + 120, { steps: 5 }); await page.mouse.up();
  await page.locator('#fbFit').click();
  expect(await running()).toBeGreaterThan(0);
});
