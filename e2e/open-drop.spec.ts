// A note (or folder) dragged in from the OS: onto the pill at the top it OPENS, to be edited in place
// (features/open-drop.ts); anywhere else on the board it's ADDED as a card. The OS drag is played as DOM drag
// events over a file in the browser's own storage, whose handle the stubbed getAsFileSystemHandle hands over.
import { test, expect, type Page } from '@playwright/test';
import { openBoard, card, clickAway, saved, watchErrors } from './helpers';

type Stubs = Window & { __act: boolean; __perm: PermissionState };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Stubs;
    w.__act = true;
    w.__perm = 'granted';
    const proto = FileSystemHandle.prototype as unknown as Record<string, unknown>;
    proto.queryPermission = async () => w.__perm;

    // without a click to go on, Chrome refuses to ask at all
    proto.requestPermission = async () => {
      if (!w.__act) {
        throw new DOMException('User activation is required to request permissions.', 'SecurityError');
      }
      return 'granted';
    };
    (DataTransferItem.prototype as unknown as Record<string, unknown>).getAsFileSystemHandle = async function (this: DataTransferItem) {
      const root = await navigator.storage.getDirectory(), name = this.getAsFile()!.name;
      return /\.md$/.test(name) ? root.getFileHandle(name) : root.getDirectoryHandle(name);
    };
  });
});

async function writeFile(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(async ({ path, text }) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/');
    for (const p of parts.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(p, { create: true });
    }
    const w = await (await dir.getFileHandle(parts[parts.length - 1]!, { create: true })).createWritable();
    await w.write(text); await w.close();
  }, { path, text });
}
const readFile = (page: Page, name: string): Promise<string> => page.evaluate(async (name) =>
  (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile().then(f => f.text()), name);

// Drag `name` in over the board, then let go on the pill or on the board (or not at all: it leaves the window).
async function dragIn(page: Page, name: string, end: 'pill' | 'board' | 'leave'): Promise<void> {
  await page.evaluate(({ name, end }) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# dragged\n'], name, { type: name.endsWith('.md') ? 'text/markdown' : '' }));
    const fire = (type: string, el: Element, x: number, y: number, extra: DragEventInit = {}): void => {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y, ...extra }));
    };
    const board = document.elementFromPoint(600, 450)!;
    fire('dragenter', board, 600, 450);
    fire('dragover', board, 600, 450);
    if (end === 'leave') {
      fire('dragleave', board, 600, 450, { relatedTarget: null });
    } else if (end === 'board') {
      fire('drop', board, 600, 450);
    } else {
      const pill = document.getElementById('openDrop')!, r = pill.getBoundingClientRect();
      fire('dragover', pill, r.left + r.width / 2, r.top + r.height / 2);
      fire('drop', pill, r.left + r.width / 2, r.top + r.height / 2);
    }
  }, { name, end });
}
const crumb = (page: Page) => page.locator('#folderName .sc-name');

test('a note dragged onto the pill opens to be edited in place; dropped on the board it is added as a card', async ({ page }) => {
  const errors = watchErrors(page);
  await openBoard(page);
  await writeFile(page, 'Audit.md', '# Audit\n\n- one\n');
  const board = await crumb(page).textContent();

  // the pill offers itself while the note is over the window, and goes when it leaves
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([''], 'Audit.md', { type: 'text/markdown' }));
    document.elementFromPoint(600, 450)!.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await expect(page.locator('#openDrop')).toBeVisible();
  await expect(page.locator('#openDropTitle')).toHaveText('Drop here to edit it in place');
  await dragIn(page, 'Audit.md', 'leave');
  await expect(page.locator('#openDrop')).toBeHidden();

  await dragIn(page, 'Audit.md', 'board');
  await expect(page.locator('#openDrop')).toBeHidden();
  await expect(page.locator('#world .node')).toHaveCount(1);   // a copy, added to the board that was open
  await expect(crumb(page)).toHaveText(board!);

  await dragIn(page, 'Audit.md', 'pill');
  await expect(crumb(page)).toHaveText('Audit');
  await expect(page.locator('#world .node')).toHaveCount(1);
  await card(page, 'Audit').dblclick();
  await page.locator('textarea.body-edit').fill('# Audit\n\n- one\n- two');
  await clickAway(page);
  await saved(page);
  expect(await readFile(page, 'Audit.md')).toContain('# Audit\n\n- one\n- two\n');
  expect(errors).toEqual([]);
});

test('over a single note, a drop anywhere opens the dragged note in its place', async ({ page }) => {
  await openBoard(page);
  await writeFile(page, 'Audit.md', '# Audit\n');
  await writeFile(page, 'Other.md', '# Other\n');
  await dragIn(page, 'Audit.md', 'pill');
  await expect(crumb(page)).toHaveText('Audit');
  // Opening a note looks for it among the notes opened before, which reads their stored handles back out of
  // IndexedDB — and headless Chromium crashes reading an OPFS handle from there (single-note.spec.ts), so
  // the list is emptied first.
  await page.evaluate(() => localStorage.setItem('corkboard.maps',
    JSON.stringify(JSON.parse(localStorage.getItem('corkboard.maps')!).filter((m: { kind: string }) => m.kind !== 'note'))));
  await dragIn(page, 'Other.md', 'board');
  await expect(crumb(page)).toHaveText('Other');
  await expect(card(page, 'Other')).toBeVisible();
  expect(await readFile(page, 'Audit.md')).toBe('# Audit\n');
});

test('a drop that can’t ask for write access leaves a button that finishes opening on a click', async ({ page }) => {
  await openBoard(page);
  await writeFile(page, 'Audit.md', '# Audit\n');
  await page.evaluate(() => { const w = window as unknown as Stubs; w.__perm = 'prompt'; w.__act = false; });
  await dragIn(page, 'Audit.md', 'pill');
  await expect(page.locator('#openDrop')).toHaveClass(/ask/);
  await expect(page.locator('#openDropTitle')).toHaveText('Open “Audit.md”');
  await expect(crumb(page)).not.toHaveText('Audit');
  await page.evaluate(() => { (window as unknown as Stubs).__act = true; });
  await page.locator('#openDrop').click();
  await expect(crumb(page)).toHaveText('Audit');
  await expect(page.locator('#openDrop')).toBeHidden();
});

test('a folder dragged onto the pill opens as a board', async ({ page }) => {
  await openBoard(page);
  await writeFile(page, 'picked/Idea.md', '# Idea\n');
  await dragIn(page, 'picked', 'pill');
  await expect(crumb(page)).toHaveText('picked');
  await expect(card(page, 'Idea')).toBeVisible();
});
