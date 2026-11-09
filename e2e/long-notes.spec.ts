// A long, structured note in one card — a checklist with sections and tables: it is never lost mid-edit,
// it frames and edits readably however tall it is, and its tables fit the card.
import { test, expect, type Page, type Locator } from '@playwright/test';
import { openBoard, seedBoard, card, clickAway, diskFiles, palette, settled } from './helpers';

const ROWS = Array.from({ length: 12 }, (_, i) =>
  `| A${i + 1} | **Item ${i + 1}**: a description long enough to wrap over several lines in a card | A test or pass criterion | H |`).join('\n');
const DOC = `# Audit\n\n## A — Architecture\n\n| # | Item | Test / pass criterion | Cost |\n|---|---|---|---|\n${ROWS}\n\n## B — Interaction\n\n`
  + Array.from({ length: 60 }, (_, i) => `- B${i + 1} line of the second section`).join('\n') + '\n';

async function seedDoc(page: Page, w = 200): Promise<Locator> {
  await seedBoard(page, { 'Audit.md': DOC, 'board.json': JSON.stringify({ version: 1, model: 2, settings: {},
    edges: [], nodes: { 'Audit.md': { x: 0, y: 0, w } } }) });
  return card(page, 'Audit');
}
const zoom = (page: Page): Promise<number> =>
  page.locator('#world').evaluate(el => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)?.[1]));
const editor = (page: Page): Locator => page.locator('textarea.body-edit');
// Open the editor with the caret at the end of the title line.
async function openAtTitleEnd(page: Page, c: Locator): Promise<void> {
  await c.locator('h1').dblclick();
  await expect(editor(page)).toBeFocused();
  await editor(page).evaluate((ta: HTMLTextAreaElement) => ta.setSelectionRange(7, 7));   // after `# Audit`
}
const diskText = async (page: Page): Promise<string> => Object.values(await diskFiles(page)).join('\n');

test('a table wider than a narrow card is squeezed to fit it, and Resize to fit widens the card for it', async ({ page }) => {
  await openBoard(page);
  const c = await seedDoc(page);
  const fits = () => c.locator('table').evaluate(t => t.offsetWidth <= t.parentElement!.clientWidth + 1);
  expect(await fits()).toBe(true);
  await c.locator('h1').click();   // its top: a tall card's middle is off the screen
  await settled(page);
  await palette(page, 'Resize to fit');
  expect(await c.evaluate(el => el.offsetWidth)).toBeGreaterThan(400);
  await expect(c.locator('table')).not.toHaveClass(/squeezed/);
  expect(await fits()).toBe(true);
});

test('F frames a tall card from its top at a readable zoom', async ({ page }) => {
  await openBoard(page);
  const c = await seedDoc(page, 600);
  await c.locator('h1').click();   // its top: a tall card's middle is off the screen
  await settled(page);
  await page.keyboard.press('f');
  await settled(page);
  expect(await zoom(page)).toBeGreaterThanOrEqual(0.5);
  await expect(c.locator('h1')).toBeInViewport();
});

test('an open edit reaches the disk while you pause, and when the page goes away', async ({ page }) => {
  await openBoard(page);
  const c = await seedDoc(page, 600);
  await openAtTitleEnd(page, c);
  await page.keyboard.insertText(' pause');
  await expect.poll(() => diskText(page), { timeout: 5000 }).toContain('# Audit pause');
  await page.keyboard.insertText(' hide');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => diskText(page), { timeout: 1000 }).toContain('# Audit pause hide');
  await expect(editor(page)).toBeFocused();                  // still editing: nothing closed it
});

test('Esc keeps the edit, and ⌘Z takes it back', async ({ page }) => {
  await openBoard(page);
  const c = await seedDoc(page, 600);
  await openAtTitleEnd(page, c);
  await page.keyboard.insertText(' kept');
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  await expect(c.locator('h1')).toHaveText('Audit kept');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(c.locator('h1')).toHaveText('Audit');
});

test('typing at the end of a tall note walks the view along, and leaving keeps the line in place', async ({ page }) => {
  await openBoard(page);
  const c = await seedDoc(page, 600);
  await c.locator('h1').click();   // its top: a tall card's middle is off the screen
  await settled(page);
  await page.keyboard.press('f');
  await settled(page);
  await c.locator('h1').dblclick();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('the very end');
  await settled(page);
  expect(await page.locator('#stage').evaluate(s => s.scrollTop)).toBe(0);   // the camera moved, not #stage
  const caretY = await editor(page).evaluate((ta: HTMLTextAreaElement) => ta.getBoundingClientRect().bottom);
  expect(caretY).toBeLessThan(800 + 60);                     // the end of the note is on screen
  await clickAway(page);
  await settled(page);
  await expect(c.locator('li', { hasText: 'the very end' })).toBeInViewport();
});

test('triple-click on a heading selects its section', async ({ page }) => {
  await openBoard(page);
  const c = await seedDoc(page, 600);
  await c.locator('h1').dblclick();
  const ta = editor(page);
  // the `## B — Interaction` line, located in the textarea by its line number
  const at = await ta.evaluate((el: HTMLTextAreaElement) => {
    const line = el.value.split('\n').findIndex(l => l.startsWith('## B'));
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), k = r.height / el.offsetHeight;
    // every line above it is short enough not to wrap only in a wide card, so measure with a mirror instead
    const m = document.createElement('div');
    Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', font: cs.font,
      lineHeight: cs.lineHeight, padding: cs.padding, width: cs.width, boxSizing: cs.boxSizing, overflowWrap: cs.overflowWrap });
    m.textContent = el.value.split('\n').slice(0, line).join('\n') + '\n';
    const s = m.appendChild(document.createElement('span'));
    s.textContent = 'x';
    document.body.appendChild(m);
    const y = s.offsetTop + s.offsetHeight / 2;
    m.remove();
    return { x: r.left + 30 * k, y: r.top + y * k };
  });
  await page.mouse.click(at.x, at.y, { clickCount: 3 });
  const sel = await ta.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd));
  expect(sel.startsWith('## B — Interaction')).toBe(true);
  expect(sel.endsWith('B60 line of the second section')).toBe(true);
});
