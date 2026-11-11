// Getting text onto the board and back off it: a drop from another app, number-key colours, and a copy
// that other apps read as clean text yet pastes back onto the board as the same cards.
import { test, expect } from '@playwright/test';
import { openBoard, makeCard, select, card, clickAway, watchErrors, palette } from './helpers.js';

test('text dropped from another app becomes cards, a list one per item', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', '- Dropped one\n- Dropped two');
    const at = { clientX: 500, clientY: 400, bubbles: true, cancelable: true, dataTransfer };
    const target = document.elementFromPoint(500, 400)!;
    target.dispatchEvent(new DragEvent('dragover', at));
    target.dispatchEvent(new DragEvent('drop', at));
  });
  await expect(card(page, 'Dropped one')).toBeVisible();
  await expect(card(page, 'Dropped two')).toBeVisible();
  expect(errors).toEqual([]);
});

test('2 colours the selection red; a copy reads as an outline and pastes back as the same cards', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openBoard(page);
  const a = await makeCard(page, 300, 300, '# Alpha\nsecret body');
  const b = await makeCard(page, 600, 300, 'Beta');
  await select(page, a);
  await page.keyboard.press('2');
  await expect(a).toHaveClass(/\bc-red\b/);
  await b.click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('- Alpha\n  secret body\n- Beta');
  await clickAway(page);
  await page.mouse.move(500, 600);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('#world .node.c-red', { hasText: 'Alpha' })).toHaveCount(2);   // the payload, not a list
});

test('copy as formatted text puts the rendered note beside the markdown, and still pastes back as cards', async ({ page, context }) => {
  const errors = watchErrors(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openBoard(page);
  const a = await makeCard(page, 300, 300, '# Plan\n**bold** move\n- [x] done');
  await select(page, a);
  await palette(page, 'Copy as formatted text');
  const read = (): Promise<{ html: string; text: string }> => page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const part = async (type: string): Promise<string> => item.types.includes(type) ? (await item.getType(type)).text() : '';
    return { html: await part('text/html'), text: await part('text/plain') };
  });
  await expect.poll(async () => (await read()).html).toContain('<h1>Plan</h1><p><strong>bold</strong> move</p><ul><li>☑ done</li></ul>');
  expect((await read()).text).toMatch(/^# Plan\n+\*\*bold\*\* move\n- \[x\] done$/);   // the same markdown a plain copy writes
  await clickAway(page);
  await page.mouse.move(600, 500);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('#world .node', { hasText: 'Plan' })).toHaveCount(2);   // the payload, not a new note
  expect(errors).toEqual([]);
});
