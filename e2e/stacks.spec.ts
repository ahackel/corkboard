// STACKS — a section drawn as a pile (features/stacks.ts): hold a dragged card over another to make one, drop
// on a pile to add to it, drag the pile's body to lift its top card off, drag its pin to move it whole, click
// it to fan it out. Down to one card, it's no stack any more.
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, seedBoard, note, card, makeCard, watchErrors, diskFiles, palette, select, centre, dragTo, settled } from './helpers';

const NODES = {
  'Loose.md': { x: 400, y: 0 },
  'Pile/_index.md': { x: 0, y: 0, stack: true, order: ['Pile/One.md', 'Pile/Two.md', 'Pile/Three.md'] },
  'Pile/One.md': { x: 0, y: 0 }, 'Pile/Two.md': { x: 0, y: 0 }, 'Pile/Three.md': { x: 0, y: 0 },
};
const board = (nodes: Record<string, unknown>): string =>
  JSON.stringify({ version: 1, model: 2, settings: { grid: 'dot', gridSize: 20 }, edges: [], nodes });
const BOARD = {
  'Loose.md': note('A loose card'),
  'Pile/_index.md': note('', { 'mm_type': 'frame', 'mm_blank': 'true' }),
  'Pile/One.md': note('Bottom card'),
  'Pile/Two.md': note('Middle card'),
  'Pile/Three.md': note('Top card'),
  'board.json': board(NODES),
};

const stack = (page: Page): Locator => page.locator('#world .node.stack');

test('holding a card over another makes a stack; a quick pass does not', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const a = await makeCard(page, 300, 300, 'Alpha');
  const b = await makeCard(page, 700, 300, 'Beta');
  // passing over Beta on the way somewhere else is just a pass
  await page.mouse.move((await centre(a)).x, (await centre(a)).y);
  await page.mouse.down();
  await page.mouse.move((await centre(b)).x, (await centre(b)).y, { steps: 8 });
  await page.mouse.move(1000, 560, { steps: 8 });
  await page.mouse.up();
  await settled(page);
  await expect(stack(page)).toHaveCount(0);
  await dragTo(page, await centre(a), await centre(b), { hold: 700 });
  await expect(stack(page)).toHaveCount(1);
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
  // the new stack is selected, and its ring goes round the whole pile, not along one edge of it
  const ring = (await stack(page).locator('.stack-ring').boundingBox())!;
  const pile = (await stack(page).locator('.pile').boundingBox())!;
  expect(ring.height).toBeGreaterThanOrEqual(pile.height);
  expect(ring.width).toBeGreaterThanOrEqual(pile.width);
  await expect(stack(page).locator('.pile-card').last()).toContainText('Alpha');   // the last one added is on top
  const files = Object.keys(await diskFiles(page));
  expect(files).toEqual(expect.arrayContaining(['Stack/_index.md', 'Stack/Alpha.md', 'Stack/Beta.md']));
  expect(errors).toEqual([]);
});

test('a plain drop on a stack puts the card on top of it', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await expect(stack(page)).toHaveAttribute('data-cards', '3');
  // the bottom card lies square; the ones on it are askew
  await expect(stack(page).locator('.pile-card').first()).toHaveCSS('rotate', '0deg');
  await expect(stack(page).locator('.pile-card').nth(1)).not.toHaveCSS('rotate', '0deg');
  await dragTo(page, await centre(card(page, 'A loose card')), await centre(stack(page)));
  await expect(stack(page)).toHaveAttribute('data-cards', '4');
  await expect(stack(page).locator('.pile-card').last()).toContainText('A loose card');
  expect(Object.keys(await diskFiles(page))).toContain('Pile/Loose.md');
  expect(errors).toEqual([]);
});

test('dragging the pile lifts its top card off; dragging the pin moves the whole stack', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  const at = await centre(stack(page));
  await dragTo(page, at, { x: at.x + 250, y: at.y + 200 });
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
  await expect(page.locator('#world .node:not(.stack)', { hasText: 'Top card' })).toBeVisible();
  const before = (await stack(page).boundingBox())!;
  const pin = await centre(stack(page).locator('.stack-pin'));
  await dragTo(page, pin, { x: pin.x - 150, y: pin.y + 120 });
  const after = (await stack(page).boundingBox())!;
  expect(after.x).toBeLessThan(before.x - 100);
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
  expect(errors).toEqual([]);
});

test('a stack down to one card lets it go', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  for (const i of [0, 1]) {
    const at = await centre(stack(page));
    await dragTo(page, at, { x: at.x + 240, y: at.y + 160 + i * 120 });
  }
  await expect(stack(page)).toHaveCount(0);
  await expect(card(page, 'Bottom card')).toBeVisible();
  const files = Object.keys(await diskFiles(page));
  expect(files).toContain('One.md');
  expect(files.some(f => f.startsWith('Pile/'))).toBe(false);
  expect(errors).toEqual([]);
});

test('a click fans the stack out, and Esc puts it back', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await stack(page).click();
  await settled(page);
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(3);
  await expect(page.locator('#fanScrim')).toBeVisible();
  // a fanned card dragged out onto the board leaves the stack
  const top = page.locator('#world .node.fanned', { hasText: 'Top card' });
  const from = await centre(top);
  await dragTo(page, from, { x: 1100, y: 700 });
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(0);
  await expect(page.locator('#fanScrim')).toHaveCount(0);
  await expect(stack(page)).toHaveAttribute('data-cards', '2');
  expect(errors).toEqual([]);
});

test('the fan glides out of the pile and back onto it, even with Reduce motion on', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openBoard(page, { motion: true });
  await seedBoard(page, BOARD);
  const pile = (await stack(page).boundingBox())!;
  const card = page.locator('#world .node.fanned', { hasText: 'Top card' });
  const dist = async (): Promise<number> => { const b = (await card.boundingBox())!; return Math.hypot(b.x - pile.x, b.y - pile.y); };
  const scrimOpacity = async (): Promise<number> => Number(await page.locator('#fanScrim').evaluate(e => getComputedStyle(e).opacity));
  await stack(page).click();
  await page.waitForTimeout(120);
  const midOpen = await dist();
  const dimming = await scrimOpacity();
  await settled(page);
  const open = await dist();
  expect(midOpen).toBeGreaterThan(2);           // on its way out…
  expect(midOpen).toBeLessThan(open - 2);       // …not there yet
  expect(dimming).toBeGreaterThan(0);           // and the board dims along with it
  expect(dimming).toBeLessThan(1);
  expect(await scrimOpacity()).toBe(1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await expect(card).toBeVisible();             // still gliding home, not gone at once
  expect(await scrimOpacity()).toBeLessThan(1); // the dimming lifts as they go
  expect(await dist()).toBeLessThan(open - 2);
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(0);
  await expect(page.locator('#fanScrim')).toHaveCount(0);
});

test('the cards keep the pile\'s z order while the fan glides out and back', async ({ page }) => {
  await openBoard(page, { motion: true });
  await seedBoard(page, BOARD);
  const zs = async (): Promise<number[]> => Promise.all(['Bottom card', 'Middle card', 'Top card'].map(async t =>
    Number(await page.locator('#world .node.fanned', { hasText: t }).evaluate(e => getComputedStyle(e).zIndex))));
  const inOrder = (z: number[]): boolean => z[0] < z[1] && z[1] < z[2];
  await stack(page).click();
  await page.waitForTimeout(120);
  expect(inOrder(await zs())).toBe(true);       // gliding out: the top card still on top
  await settled(page);
  expect(inOrder(await zs())).toBe(true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  expect(inOrder(await zs())).toBe(true);       // gliding home: likewise
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(0);
});

test('the fan turns and dims each card as it lies on the pile, so the pile does not snap it', async ({ page }) => {
  await openBoard(page, { motion: true });
  await seedBoard(page, BOARD);
  const lie = (loc: Locator): Promise<string> => loc.evaluate(e => {
    const cs = getComputedStyle(e);
    return `${cs.rotate}|${cs.translate}`;
  });
  const onPile = async (t: string): Promise<string> => lie(stack(page).locator('.pile-card', { hasText: t }));
  const pile = [await onPile('Middle card'), await onPile('Top card')];
  expect(pile[0]).not.toBe(pile[1]);
  await stack(page).click();
  await settled(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(30);

  // the glide's destination: the pile's own angle and nudge for that card
  const target = async (t: string): Promise<string> => page.locator('#world .node.fanned', { hasText: t }).evaluate(e => {
    const el = e as HTMLElement;
    return `${parseFloat(el.style.getPropertyValue('--tilt'))}deg|${el.style.translate}`;
  });
  for (const [i, t] of ['Middle card', 'Top card'].entries()) {
    const [rot, nudge] = pile[i].split('|');
    const [tilt, shift] = (await target(t)).split('|');
    expect(parseFloat(tilt)).toBeCloseTo(parseFloat(rot), 1);
    expect(shift).toBe(nudge);
  }

  // …and the pile's darkening of every card but the top one
  const dim = async (t: string): Promise<string> =>
    page.locator('#world .node.fanned', { hasText: t }).evaluate(e => (e as HTMLElement).style.getPropertyValue('--fan-dim'));
  expect(await dim('Middle card')).toBe('var(--pile-dim)');
  expect(await dim('Top card')).toBe('1');
  await expect(stack(page).locator('.pile-card', { hasText: 'Middle card' })).toHaveClass(/under/);
  await expect(stack(page).locator('.pile-card', { hasText: 'Top card' })).not.toHaveClass(/under/);
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(0);
});

test('a fan lines its cards up by their TOP edges, a taller one hanging lower', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, {
    'Pile/_index.md': note('', { 'mm_type': 'frame', 'mm_blank': 'true' }),
    'Pile/Short.md': note('Short card'),
    'Pile/Tall.md': note('Tall card'),
    'board.json': board({
      'Pile/_index.md': { x: 0, y: 0, stack: true, order: ['Pile/Short.md', 'Pile/Tall.md'] },
      'Pile/Short.md': { x: 0, y: 0 }, 'Pile/Tall.md': { x: 0, y: 0, w: 200, h: 300 },
    }),
  });
  await stack(page).click();
  await settled(page);
  const top = async (t: string): Promise<number> => (await page.locator('#world .node.fanned:visible', { hasText: t }).boundingBox())!.y;
  const heights = await Promise.all(['Short card', 'Tall card'].map(async t =>
    (await page.locator('#world .node.fanned:visible', { hasText: t }).boundingBox())!.height));
  expect(heights[1]).toBeGreaterThan(heights[0] + 50);
  expect(Math.abs(await top('Short card') - await top('Tall card'))).toBeLessThan(12);   // the tilt moves a corner a little
});

test('fanning spreads the cards over the pile, a little up, without moving the camera; the pin swells and fades, above the cards', async ({ page }) => {
  await openBoard(page, { motion: true });
  await seedBoard(page, BOARD);
  const world = page.locator('#world');
  const worldBox = async (): Promise<string> => JSON.stringify(await world.boundingBox());
  const before = await worldBox();
  const pileTop = (await stack(page).boundingBox())!.y;
  const pin = stack(page).locator('.stack-pin');
  const look = (): Promise<{ opacity: number; scale: number }> => pin.evaluate(e => {
    const cs = getComputedStyle(e);
    return { opacity: Number(cs.opacity), scale: new DOMMatrix(cs.transform).a };
  });
  const rest = await look();
  const pinIsOnTop = (): Promise<boolean> => page.evaluate(() => {
    const z = (e: Element): number => Number(getComputedStyle(e).zIndex);
    const pile = document.querySelector('#world .node.stack')!;
    return [...document.querySelectorAll('#world .node.fanned')].every(c => z(pile) > z(c))
      && z(pile) > z(document.getElementById('fanScrim')!);
  });
  await stack(page).click();
  await page.waitForTimeout(200);
  expect(await pinIsOnTop()).toBe(true);        // above the cards while they glide out
  const mid = await look();
  expect(mid.opacity).toBeGreaterThan(0);
  expect(mid.opacity).toBeLessThan(1);          // fading out as the cards spread…
  expect(mid.scale).toBeGreaterThan(rest.scale); // …and swelling
  await settled(page);
  expect((await look()).opacity).toBe(0);
  const tops = await Promise.all(['Top card', 'Middle card', 'Bottom card'].map(async t =>
    (await page.locator('#world .node.fanned:visible', { hasText: t }).boundingBox())!.y));
  expect(Math.min(...tops)).toBeGreaterThan(pileTop - 32);   // they rise a little…
  const middle = (await page.locator('#world .node.fanned:visible', { hasText: 'Middle card' }).boundingBox())!.y;
  expect(middle).toBeCloseTo(pileTop - 20, 0);               // …20px, the middle one (the ends tilt and dip)
  expect(await worldBox()).toBe(before);                      // and the camera stayed where the user had it
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await pinIsOnTop()).toBe(true);        // …and while they glide home
  const back = await look();
  expect(back.opacity).toBeGreaterThan(0);
  expect(back.opacity).toBeLessThan(1);          // the way back: reversed
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(0);
  expect((await look()).opacity).toBe(1);
  expect((await look()).scale).toBeCloseTo(rest.scale);
});

test('a fan that runs off the screen leaves the camera alone', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, BOARD);
  const view = page.viewportSize()!;
  const pile = (await stack(page).boundingBox())!;
  await page.mouse.move(view.width / 2, view.height / 2);
  await page.mouse.wheel(0, pile.y - (view.height - 30));   // the pile just inside the bottom edge
  await page.waitForTimeout(200);
  const at = (await stack(page).boundingBox())!;
  expect(at.y).toBeGreaterThan(view.height - 110);
  await stack(page).click({ position: { x: 20, y: 10 } });
  await settled(page);
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(3);
  const cards = await Promise.all(['Top card', 'Middle card', 'Bottom card'].map(t =>
    page.locator('#world .node.fanned:visible', { hasText: t }).boundingBox()));
  expect(Math.max(...cards.map(b => b!.y + b!.height))).toBeGreaterThan(view.height);   // it does run off…
  expect(Math.abs((await stack(page).boundingBox())!.y - at.y)).toBeLessThan(1);          // …and the board didn't move
});

test('Unstack spreads the cards out; Turn into section keeps them in a box', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await select(page, stack(page).locator('.stack-pin'));
  await palette(page, 'Turn into section');
  await expect(stack(page)).toHaveCount(0);
  await expect(page.locator('#world .node.section')).toHaveCount(1);
  for (const t of ['Top card', 'Middle card', 'Bottom card']) {
    await expect(card(page, t)).toBeVisible();
  }
  await page.keyboard.press('ControlOrMeta+z');
  await expect(stack(page)).toHaveCount(1);
  await select(page, stack(page).locator('.stack-pin'));
  await palette(page, 'Unstack');
  await expect(stack(page)).toHaveCount(0);
  await expect(page.locator('#world .node.section')).toHaveCount(0);
  const boxes = await Promise.all(['Top card', 'Middle card', 'Bottom card'].map(t => card(page, t).boundingBox()));
  expect(new Set(boxes.map(b => `${Math.round(b!.x)},${Math.round(b!.y)}`)).size).toBe(3);   // no longer on one spot
  expect(Object.keys(await diskFiles(page))).toContain('Three.md');
  expect(errors).toEqual([]);
});

test('dragging a card within the fan shows a line where it will go, and drops it there', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, BOARD);
  await stack(page).click();
  await settled(page);
  const top = page.locator('#world .node.fanned:visible', { hasText: 'Top card' });
  const last = (await page.locator('#world .node.fanned:visible', { hasText: 'Bottom card' }).boundingBox())!;
  await page.mouse.move((await centre(top)).x, (await centre(top)).y);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width * 0.8, last.y + last.height / 2, { steps: 12 });
  await expect(page.locator('#fanInsert')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('#fanInsert')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // it went to the BOTTOM of the pile (the far end of the fan), so the middle card is on top now
  await expect(stack(page).locator('.pile-card').last()).toContainText('Middle card');
  expect(errors).toEqual([]);
});

test('a stack\'s colour is its pin\'s, red by default; its cards keep their own', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, { ...BOARD,
    'Blue/_index.md': note('', { 'mm_type': 'frame', 'mm_blank': 'true', 'color': 'blue' }),
    'Blue/A.md': note('Blue one'), 'Blue/B.md': note('Blue two'),
    'board.json': board({ ...NODES, 'Blue/_index.md': { x: 0, y: 400, stack: true }, 'Blue/A.md': { x: 0, y: 0 }, 'Blue/B.md': { x: 0, y: 0 } }) });
  const pin = stack(page).filter({ hasText: 'Top card' }).locator('.stack-pin');
  const blue = stack(page).filter({ hasText: 'Blue' });
  await expect(pin).toHaveCSS('background-color', 'rgb(242, 72, 34)');
  await expect(blue.locator('.stack-pin')).not.toHaveCSS('background-color', 'rgb(242, 72, 34)');
  await expect(blue.locator('.pile-card').last()).toHaveClass(/c-amber/);   // its cards keep a sticky's own yellow
  // …and the colour picker shows the red for an uncoloured one, not the white of an uncoloured section
  await select(page, pin);
  await expect(page.locator('#edColors .swatch.active')).toHaveAttribute('data-color', 'bold-red');
  expect(errors).toEqual([]);
});

test('Ungroup on a stack and a section together lets both go, in one step', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await seedBoard(page, { ...BOARD,
    'Box/_index.md': note('# Box', { 'mm_type': 'frame' }), 'Box/In.md': note('In the box'),
    'board.json': board({ ...NODES, 'Box/_index.md': { x: 0, y: 400, w: 300, h: 200 }, 'Box/In.md': { x: 40, y: 60 } }) });
  await select(page, stack(page).locator('.stack-pin'));
  await page.locator('#world .node.section', { hasText: 'Box' }).locator(':scope > .title-row').click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('ControlOrMeta+Backspace');
  await expect(stack(page)).toHaveCount(0);
  await expect(page.locator('#world .node.section')).toHaveCount(0);
  for (const t of ['Top card', 'Middle card', 'Bottom card', 'In the box']) {
    await expect(card(page, t)).toBeVisible();
  }
  const boxes = await Promise.all(['Top card', 'Middle card', 'Bottom card'].map(t => card(page, t).boundingBox()));
  expect(new Set(boxes.map(b => `${Math.round(b!.x)},${Math.round(b!.y)}`)).size).toBe(3);   // spread out, not a heap
  await page.keyboard.press('ControlOrMeta+z');
  await expect(stack(page)).toHaveCount(1);
  await expect(page.locator('#world .node.section')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a pile stands on its BOTTOM card: a wider card on it is centred over it, and every card keeps its height', async ({ page }) => {
  await openBoard(page);
  await seedBoard(page, {
    'Pile/_index.md': note('', { 'mm_type': 'frame', 'mm_blank': 'true' }),
    'Pile/Narrow.md': note('Narrow card'),
    'Pile/Wide.md': note('Wide card'),
    'board.json': board({
      'Pile/_index.md': { x: 0, y: 0, stack: true, order: ['Pile/Narrow.md', 'Pile/Wide.md'] },
      'Pile/Narrow.md': { x: 0, y: 0 }, 'Pile/Wide.md': { x: 0, y: 0, w: 360, h: 300 },
    }),
  });
  const cards = await stack(page).locator('.pile-card').evaluateAll(els => els.map(e => {
    const el = e as HTMLElement;
    return { left: el.offsetLeft, w: el.offsetWidth, h: el.offsetHeight };
  }));
  const el = await stack(page).evaluate(e => ({ w: (e as HTMLElement).offsetWidth, h: (e as HTMLElement).offsetHeight }));
  expect(cards[0].left).toBe(0);                                        // the narrow bottom card stays put…
  expect(el.w).toBe(cards[0].w);                                        // …and is the pile's footprint
  expect(el.h).toBe(cards[0].h);
  expect(cards[1].left + cards[1].w / 2).toBeCloseTo(cards[0].w / 2);   // the wide one is centred over it
  expect(cards[1].h).toBe(300);                                         // at its own height
  expect(cards[0].h).toBeLessThan(300);

  // what hangs over the bottom card is still the pile: a click there fans it out
  const box = (await stack(page).boundingBox())!;
  await page.mouse.click(box.x - 40, box.y + 150);
  await expect(page.locator('body')).toHaveClass(/fan-open/);
});

test('an image card can be dragged out of the fan like any card', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="red"/></svg>');
  await seedBoard(page, {
    ...BOARD,
    'Pile/Pic.md': note(`![pic](data:image/svg+xml;base64,${svg.toString('base64')})`),
    'board.json': board({ ...NODES, 'Pile/_index.md': { ...NODES['Pile/_index.md'], order: [...NODES['Pile/_index.md'].order, 'Pile/Pic.md'] },
      'Pile/Pic.md': { x: 0, y: 0, w: 200, h: 150 } }),
  });
  await stack(page).click();
  await settled(page);
  const pic = page.locator('#world .node.fanned.image-card');
  await expect(pic).toBeVisible();
  await dragTo(page, await centre(pic), { x: 1100, y: 700 });
  await expect(page.locator('#fanScrim')).toBeVisible();   // the fan stayed open
  await expect(page.locator('#world .node.fanned:visible')).toHaveCount(3);
  await expect(stack(page)).toHaveAttribute('data-cards', '3');
  expect(errors).toEqual([]);
});
