import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, makeCard, clickAway, select, card } from './helpers';

const editor = (c: Locator) => c.locator('textarea.body-edit');
// Open a fresh card with N and leave its editor open, for the keys under test.
async function freshEditor(page: Page): Promise<Locator> {
  await page.mouse.move(400, 300);
  await page.keyboard.press('n');
  await expect(page.locator('textarea.body-edit')).toBeFocused();
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
  await page.keyboard.press('ControlOrMeta+l');                // a numbered item becomes a numbered task
  await expect(ta).toHaveValue('1. a\n2. c\n3. [ ] b');
  await page.keyboard.press('ControlOrMeta+l');
  await expect(ta).toHaveValue('1. a\n2. c\n3. [x] b');
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

test('a click on the selected card opens its editor with the caret where it landed', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Title\n\nalpha **beta** gamma');
  await clickAway(page);
  const box = (await c.locator('.body strong').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);   // selects…
  await expect(editor(c)).toHaveCount(0);
  await page.waitForTimeout(600);                                           // (not a double-click)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);   // …and writes
  const ta = editor(c);
  await expect(ta).toBeFocused();
  const caret = await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart === el.selectionEnd, el.value.slice(el.selectionStart)]);
  expect(caret[0]).toBe(true);
  expect(caret[1]).toMatch(/^ta\*\* gamma$|^a\*\* gamma$/);     // mid-"beta", wherever the half falls
  await clickAway(page);
  const h1 = (await c.locator('.body h1').boundingBox())!;
  await page.mouse.click(h1.x + 3, h1.y + h1.height / 2);                // the title is the note's first line
  await expect(ta).toBeFocused();
  expect(await ta.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBeLessThanOrEqual(3);
});

test('a double-click opens the editor with all of the note selected, selected beforehand or not', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, '# Title\n\nalpha beta');
  const all = () => editor(c).evaluate((el: HTMLTextAreaElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length);
  await c.locator('.body p').dblclick();      // still the selection makeCard left
  await expect(editor(c)).toBeFocused();
  expect(await all()).toBe(true);
  await page.keyboard.press('Escape');
  await clickAway(page);                      // nothing selected now
  await c.locator('.body p').dblclick();
  await expect(editor(c)).toBeFocused();
  expect(await all()).toBe(true);
});

test('double-clicking a word in an open editor still selects just that word', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'alpha beta gamma');
  await page.keyboard.press('e');
  const ta = editor(c);
  await expect(ta).toBeFocused();
  await page.waitForTimeout(600);
  const b = (await ta.boundingBox())!;
  await page.mouse.dblclick(b.x + 8, b.y + b.height / 2);
  expect(await ta.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('alpha');
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

test('confirming an edit never changes the card\'s size, though the raw note stands taller', async ({ page }) => {
  await openBoard(page);
  const c = await makeCard(page, 400, 300, 'many\n\n' + Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n\n'));
  await c.dblclick();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' more');
  const editing = (await c.boundingBox())!;
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(c.locator('textarea.body-edit')).toHaveCount(0);
  const after = (await c.boundingBox())!;
  expect(after.width).toBeCloseTo(editing.width, 0);
  expect(after.height).toBeCloseTo(editing.height, 0);
});

test('typing [[ offers the map’s cards, and # its tags; Enter or Tab writes the choice', async ({ page }) => {
  await openBoard(page);
  await makeCard(page, 700, 200, '# Plan for May\nship it #project');
  await makeCard(page, 700, 400, '# Planets');
  const ta = await freshEditor(page);
  const list = page.locator('#mdComplete');
  await page.keyboard.type('See [[pla');
  await expect(list).toBeVisible();
  await expect(list.locator('.mc-row')).toHaveText(['Planets', 'Plan for May']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(ta).toHaveValue('See [[Plan for May]]');
  await expect(list).toBeHidden();
  await page.keyboard.type(' and #pro');
  await expect(list.locator('.mc-row.active')).toContainText('#project');
  await page.keyboard.press('Tab');
  await expect(ta).toHaveValue('See [[Plan for May]] and #project ');
  await page.keyboard.type('#pro');
  await page.keyboard.press('Escape');                       // puts the list away, keeps the editor open
  await expect(list).toBeHidden();
  await expect(ta).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card(page, 'See Plan for May').locator('a.wikilink')).toHaveText('Plan for May');
});

test('rich text pasted from another app keeps its links and lists as markdown', async ({ page }) => {
  await openBoard(page);
  const ta = await freshEditor(page);
  await ta.evaluate((el: HTMLTextAreaElement) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'Read the docs\none\ntwo');
    dt.setData('text/html', '<p>Read <a href="https://x.y/docs">the <b>docs</b></a></p><ul><li>one</li><li>two</li></ul>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(ta).toHaveValue('Read [the **docs**](https://x.y/docs)\n\n- one\n- two');
  await clickAway(page);
  await expect(page.locator('#world .node .body a.lk')).toHaveAttribute('href', 'https://x.y/docs');
  await expect(page.locator('#world .node .body li')).toHaveCount(2);
});

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });   // a tablet, in Chromium
  test('a tap on the selected card writes in it, and a double-tap selects all of it', async ({ page }) => {
    await openBoard(page);
    const g = await makeCard(page, 300, 300, '# Groceries');
    // one tap at a time, apart: two quick ones on the canvas are a double-tap, which makes a card
    const tapAway = async () => { await page.waitForTimeout(400); await page.touchscreen.tap(600, 800); await page.waitForTimeout(400); };
    await tapAway();
    await expect(g).not.toHaveClass(/\bsel\b/);
    await g.tap();
    await expect(g).toHaveClass(/\bsel\b/);
    await expect(editor(g)).toHaveCount(0);                // a tap selects…
    await page.waitForTimeout(400);
    await g.tap();
    await expect(editor(g)).toBeFocused();                 // …and a tap on the selection writes
    await tapAway();
    await tapAway();
    await expect(g).not.toHaveClass(/\bsel\b/);
    const b = (await g.boundingBox())!;
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await expect(editor(g)).toBeFocused();
    expect(await editor(g).evaluate((el: HTMLTextAreaElement) => el.selectionStart === 0 && el.selectionEnd === el.value.length)).toBe(true);
    await expect(page.locator('#world .node')).toHaveCount(1);
  });
});
