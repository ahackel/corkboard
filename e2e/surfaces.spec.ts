// SURFACE colours (view/color.ts SURFACE_ROW): the board and sections have their own palette of tints,
// painted exactly, and cork, a texture — a card never wears either.
import { test, expect } from '@playwright/test';
import { openBoard, seedBoard, note, card, section, select, clickAway, watchErrors, diskFiles, reload } from './helpers';

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
  await page.locator('#canvasColors .swatch[data-color="cork"]').click();
  await expect(page.locator('#stage')).toHaveClass(/textured/);
  expect(errors).toEqual([]);
});

test('A section and the board picked the same tint are the same colour; its cards wear the sticky twin', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, {
    'Box/_index.md': note('# Box', { 'mm_type': 'frame', 'mm_w': '420', 'mm_h': '300' }),
    'Box/In.md': note('Pinned in the box'),
    'board.json': board({ 'Box/_index.md': { x: 0, y: 0 }, 'Box/In.md': { x: 40, y: 60 } }),
  });
  const box = section(page, 'Box');
  await select(page, box.locator('> .title-row'));
  await page.locator('#fbColor').click();
  // a section's picker is the surface palette, not the stickies
  await expect(page.locator('#edColors .swatch[data-color="blue"]')).toBeHidden();
  await page.locator('#edColors .swatch[data-color="light-blue"]').click();
  await expect(box).toHaveCSS('background-color', 'rgb(214, 238, 255)');
  await expect(card(page, 'Pinned in the box')).toHaveClass(/c-blue/);
  await clickAway(page);
  await page.locator('#canvasColorBtn').click();
  await page.locator('#canvasColors .swatch[data-color="light-blue"]').click();
  await expect(page.locator('#stage')).toHaveCSS('background-color', 'rgb(214, 238, 255)');
  expect(errors).toEqual([]);
});

test('A section coloured from the sticky palette, on disk, opens as its surface twin', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, {
    'Box/_index.md': note('# Box', { 'mm_type': 'frame', 'color': 'blue', 'mm_w': '420', 'mm_h': '300' }),
    'Box/In.md': note('Pinned in the box'),
    'board.json': board({ 'Box/_index.md': { x: 0, y: 0 }, 'Box/In.md': { x: 40, y: 60 } }),
  });
  await expect(section(page, 'Box')).toHaveClass(/c-light-blue/);
  await expect(card(page, 'Pinned in the box')).toHaveClass(/c-blue/);
  await reload(page);
  expect((await diskFiles(page))['Box/_index.md']).toContain('color: light-blue');
  expect(errors).toEqual([]);
});

test('A reload lands on the board colour instead of fading in from grey', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, {
    'Loose.md': note('A loose card'),
    'board.json': JSON.stringify({ version: 1, settings: { canvasColor: 'light-blue' }, nodes: { 'Loose.md': { x: 0, y: 0 } }, edges: [] }),
  });
  await page.reload();
  // the first moment the colour is set at all, the stage already SHOWS it — not a step of a fade from grey
  const first = await page.evaluate(() => new Promise<string>(resolve => {
    const stage = document.getElementById('stage')!;
    const check = (): void => {
      if (stage.style.getPropertyValue('--canvas-bg')) {
        resolve(getComputedStyle(stage).backgroundColor);
      } else {
        requestAnimationFrame(check);
      }
    };
    check();
  }));
  expect(first).toBe('rgb(214, 238, 255)');
});
