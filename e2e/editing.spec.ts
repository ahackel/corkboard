import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, makeCard, clickAway, select } from './helpers';

const editor = (c: Locator) => c.locator('textarea.body-edit');
// Open a fresh card with N and leave its editor open, for the keys under test.
async function freshEditor(page: Page): Promise<Locator> {
  await page.mouse.move(400, 300);
  await page.keyboard.press('n');
  await page.waitForTimeout(120);
  return page.locator('textarea.body-edit');
}

test('Enter continues a list, and Enter on an empty item ends it', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('- milk\neggs\n\nafter');
  await expect(ta).toHaveValue('- milk\n- eggs\nafter');
  await page.keyboard.press('Escape');
});

test('Tab nests an item, ⇧Tab lifts it, and the card renders the nesting', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('- a\nb');
  await page.keyboard.press('Tab');
  await expect(ta).toHaveValue('- a\n  - b');
  await expect(ta).toBeFocused();                    // Tab didn't take focus off the card
  await page.keyboard.press('Shift+Tab');
  await expect(ta).toHaveValue('- a\n- b');
  await page.keyboard.press('Tab');
  await clickAway(page);
  await expect(page.locator('#world .node .body ul > li > ul > li')).toHaveText('b');
});

test('⌘B wraps the selection, and ⌘Z in the editor takes it back', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('make it bold');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 12));
  await page.keyboard.press('ControlOrMeta+b');
  await expect(ta).toHaveValue('make it **bold**');
  await page.keyboard.press('ControlOrMeta+i');
  await expect(ta).toHaveValue('make it ***bold***');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(ta).toHaveValue('make it **bold**');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(ta).toHaveValue('make it bold');
  await page.keyboard.press('Escape');
});

test('the editor shows the note in a monospace face', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'Some text');
  await c.dblclick();
  const family = await editor(c).evaluate(el => getComputedStyle(el).fontFamily);
  expect(family).toMatch(/monospace/);
});

test('a table is started, walked with Tab and grown with Enter, and the card draws it', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('| Name | Age |\nAda');           // Enter on a lone header row starts the table
  await page.keyboard.press('Tab');
  await page.keyboard.type('36');
  await page.keyboard.press('Tab');                          // past the last cell: a new row
  await page.keyboard.type('Grace');
  await expect(ta).toHaveValue('| Name | Age |\n| ---- | --- |\n| Ada  | 36  |\n| Grace     |     |');   // tidied on the next Tab or Enter
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');                        // a new row under this one…
  await page.keyboard.press('Enter');                        // …left empty, ends the table
  await page.keyboard.type('after');
  await expect(ta).toHaveValue('| Name  | Age |\n| ----- | --- |\n| Ada   | 36  |\n| Grace |     |\nafter');
  await clickAway(page);
  await expect(page.locator('#world .node .body tbody tr')).toHaveCount(2);
});

test('Backspace takes a marker, ⌥↑ moves an item, ⌘L makes and ticks a task, numbers keep counting', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await page.keyboard.type('1. a\nb\nc\n');
  await expect(ta).toHaveValue('1. a\n2. b\n3. c\n4. ');
  await page.keyboard.press('Backspace');                    // the empty item's marker goes in one key
  await expect(ta).toHaveValue('1. a\n2. b\n3. c\n');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Alt+ArrowUp');                  // c above b — and renumbered
  await expect(ta).toHaveValue('1. a\n2. c\n3. b');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ControlOrMeta+l');                // a numbered item turns a bullet task
  await expect(ta).toHaveValue('1. a\n2. c\n- [ ] b');
  await page.keyboard.press('ControlOrMeta+l');
  await expect(ta).toHaveValue('1. a\n2. c\n- [x] b');
  await page.keyboard.press('Escape');
});

test('cells pasted from a spreadsheet become a table', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await ta.evaluate((el: HTMLTextAreaElement) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Name\tAge\nAda\t36\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(ta).toHaveValue('| Name | Age |\n| ---- | --- |\n| Ada  | 36  |');
  await clickAway(page);
  await expect(page.locator('#world .node .body tbody tr')).toHaveCount(1);
});

test('double-clicking a word in a card opens the editor with the caret on it', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Title\n\nalpha **beta** gamma');
  const box = await c.locator('.body strong').boundingBox();
  await page.mouse.dblclick(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const ta = editor(c);
  await expect(ta).toBeFocused();
  const caret = await ta.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart));
  expect(caret).toMatch(/^ta\*\* gamma$|^a\*\* gamma$/);     // mid-"beta", wherever the half falls
});

test('an image dropped beside the open editor keeps the card\'s title', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Shopping\n\nmilk');
  await select(page, c);
  await page.keyboard.press('e');
  await expect(editor(c)).toBeVisible();

  // onto the card itself, not into its textarea
  await c.evaluate(el => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(editor(c)).toHaveValue(/^# Shopping\n\nmilk\n\n!\[/);

  await clickAway(page);
  await expect(c.locator('.body h1')).toHaveText('Shopping');
});
