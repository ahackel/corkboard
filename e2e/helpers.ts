// Shared gestures for the e2e specs. Each spells ONE thing a person does on the canvas, the same way
// every time, so a spec reads as the story it tests.
import { expect, type Page, type Locator } from '@playwright/test';

// A spot on the canvas that is never under a card, a bar or the dock: clicking it clears the selection
// and ends any editor.
export const AWAY = { x: 1180, y: 60 };

export async function openBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  await page.waitForTimeout(600);   // boot onto the (fresh) map
}

export function card(page: Page, text: string): Locator {
  return page.locator('#world .node', { hasText: text }).first();
}
export function frame(page: Page, text: string): Locator {
  return page.locator('#world .node.frame', { hasText: text }).first();
}

export async function clickAway(page: Page): Promise<void> {
  await page.mouse.click(AWAY.x, AWAY.y);
  await page.waitForTimeout(120);
}

// N with the pointer at (x, y) makes a card there and opens it for typing; Enter in the editor is a
// newline, so `text` may hold several lines.
export async function makeCard(page: Page, x: number, y: number, text: string): Promise<Locator> {
  await page.mouse.move(x, y);
  await page.keyboard.press('n');
  await page.waitForTimeout(120);
  await page.keyboard.type(text);
  await clickAway(page);
  const first = text.split('\n')[0].replace(/^#\s*/, '');
  await expect(card(page, first)).toBeVisible();
  // pinned to its id, not its text: while the card is being edited its text lives in a textarea's
  // value, which a text match can't see
  const id = await card(page, first).getAttribute('data-id');
  return page.locator(`#world .node[data-id="${id}"]`);
}

export async function select(page: Page, c: Locator): Promise<void> {
  const b = (await c.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(150);
}

export type Side = 'up' | 'down' | 'left' | 'right';
// Click the selected card's port on `side` where a person would: on the dot (which is drawn over the
// port's own hit circle, so a locator click would be refused as "intercepted").
export async function clickPort(page: Page, side: Side): Promise<void> {
  const p = (await page.locator(`g.fe-socket[data-socket="${side}"] .fe-port-hit`).boundingBox())!;
  await page.mouse.click(p.x + p.width / 2, p.y + p.height / 2);
  await page.waitForTimeout(250);
}
// Where a card's floating port for `side` sits, in screen px (free-edges.ts SOCKET_OUT outside the rim).
async function portPoint(c: Locator, side: Side): Promise<{ x: number; y: number }> {
  const b = (await c.boundingBox())!, o = 17;
  return side === 'up' ? { x: b.x + b.width / 2, y: b.y - o } : side === 'down' ? { x: b.x + b.width / 2, y: b.y + b.height + o }
       : side === 'left' ? { x: b.x - o, y: b.y + b.height / 2 } : { x: b.x + b.width + o, y: b.y + b.height / 2 };
}
// Drag a line from `from`'s port on `side` onto `to` — onto its port `toSide`, or its body when omitted.
export async function drawLine(page: Page, from: Locator, side: Side, to: Locator, toSide?: Side): Promise<void> {
  await clickAway(page);
  await select(page, from);
  const port = page.locator(`g.fe-socket[data-socket="${side}"] .fe-port-hit`);
  const p = (await port.boundingBox())!;
  const t = (await to.boundingBox())!;
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 });   // over the body first: its ports show
  if (toSide) { const q = await portPoint(to, toSide); await page.mouse.move(q.x, q.y, { steps: 4 }); }
  await page.mouse.up();
  await page.waitForTimeout(200);
}

export async function palette(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.locator('#palInput').fill(command);
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

// Survive a reload: wait out the debounced autosave first.
export async function reload(page: Page): Promise<void> {
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('#stage')).toBeVisible();
  await page.waitForTimeout(800);
}

// Write a whole map straight into the board's OPFS folder and reload onto it — for scenes (nested
// frames, saved states) that would take a page of gestures to build by hand. A first card is made so
// the map's folder exists, then everything in it is replaced.
export async function seedBoard(page: Page, files: Record<string, string>): Promise<void> {
  await makeCard(page, 300, 300, 'seed');
  await page.waitForTimeout(1000);
  await page.evaluate(async (files) => {
    async function find(d: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | undefined> {
      for await (const [n, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (h.kind === 'directory') { const r = await find(h as FileSystemDirectoryHandle); if (r) return r; }
        else if (n === 'board.json' || n.endsWith('.md')) return d;
      }
      return undefined;
    }
    const dir = (await find(await navigator.storage.getDirectory()))!;
    for await (const [n] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>))
      if (n.endsWith('.md') || n === 'board.json') await dir.removeEntry(n);
    for (const [name, text] of Object.entries(files)) {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text); await w.close();
    }
  }, files);
  await page.reload();
  await expect(page.locator('#stage')).toBeVisible();
  await page.waitForTimeout(800);
  await page.keyboard.press('f');   // fit the seeded map
  await page.waitForTimeout(500);
}

export function note(body: string, fm: Record<string, string> = {}): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}${lines.length ? '\n' : ''}---\n\n${body}\n`;
}

// Collect uncaught page errors and console errors; a spec asserts the list is empty at the end.
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}
