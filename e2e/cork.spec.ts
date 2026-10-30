// CORK: a surface colour — the board and sections wear it as a texture, a card never does
// (view/color.ts isSurfaceOnly).
import { test, expect } from '@playwright/test';
import { openBoard, seedBoard, note, card, section, select, clickAway, watchErrors } from './helpers';

const board = (nodes: Record<string, unknown>): string => JSON.stringify({ version: 1, nodes, edges: [] });

test('A section and the board can be cork; a card in a cork section stays a sticky', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, {
    'Loose.md': note('A loose card'),
    'Box/_index.md': note('# Box', { 'mm_type': 'frame', 'mm_w': '420', 'mm_h': '300' }),
    'Box/In.md': note('Pinned in the box'),
    'board.json': board({ 'Loose.md': { x: 600, y: 0 }, 'Box/_index.md': { x: 0, y: 0 }, 'Box/In.md': { x: 40, y: 60 } }),
  });
  // a CARD's picker doesn't offer cork…
  await select(page, card(page, 'A loose card'));
  await page.locator('#fbColor').click();
  await expect(page.locator('#edColors .swatch[data-color="cork"]')).toBeHidden();
  await clickAway(page);
  // …a section's does, and the box wears the texture while its card stays yellow
  const box = section(page, 'Box');
  const label = box.locator('> .title-row');
  await select(page, label);
  await page.locator('#fbColor').click();
  await page.locator('#edColors .swatch[data-color="cork"]').click();
  await expect(box).toHaveClass(/c-cork/);
  await expect(box).toHaveCSS('background-image', /svg/);
  await expect(card(page, 'Pinned in the box')).toHaveClass(/c-amber/);
  await clickAway(page);
  // the board's own picker offers it too
  await page.locator('#canvasColorBtn').click();
  await page.screenshot({ path: test.info().outputPath('cork-pop.png') });
  await page.locator('#canvasColors .swatch[data-color="cork"]').click();
  await expect(page.locator('#stage')).toHaveClass(/textured/);
  expect(errors).toEqual([]);
});
