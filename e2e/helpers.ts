// Shared gestures for the e2e specs. Each spells ONE thing a person does on the canvas, the same way
// every time, so a spec reads as the story it tests.
import { expect, type Page, type Locator } from '@playwright/test';

// A spot on the canvas that is never under a card, a bar or the dock: clicking it clears the selection
// and ends any editor.
export const AWAY = { x: 1180, y: 60 };

// The canvas has come to rest: nothing on it moved for a few frames — the camera, every card's box — and
// no finite animation or transition (a fold, a fade) is still running. Glides are a mix of rAF loops
// (camera.ts, main.ts) and CSS/WAAPI, so it watches what they move rather than how.
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => {
    const world = document.getElementById('world')!;
    const snap = (): string => world.style.transform + [...world.querySelectorAll<HTMLElement>('.node')]
      .map(n => { const r = n.getBoundingClientRect(); return `${r.x},${r.y},${r.width},${r.height}`; }).join(';');
    const animating = (): boolean => document.body.classList.contains('layout-anim') || document.getAnimations().some(a =>
      a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity);
    let last = '', still = 0;
    const tick = (): void => {
      const now = snap();
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= 3 && !animating()) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }));
}

// The disk has caught up: no note or board write is queued or in flight (data/save-flag.ts).
export async function saved(page: Page): Promise<void> {
  await expect(page.locator('html')).not.toHaveAttribute('data-saving');
}

// Open a fresh board. Motion is OFF unless a spec is about the motion itself (`{ motion: true }`): every
// glide, fold and fade lands at once (utils/motion.ts), so no step waits out an animation.
export async function openBoard(page: Page, { motion = false }: { motion?: boolean } = {}): Promise<void> {
  if (!motion) {
    await page.addInitScript(() => { (window as Window & { corkboardMotion?: boolean }).corkboardMotion = false; });
  }
  await page.goto('/');
  await expect(page.locator('#stage')).toBeVisible();
  await expect(page.locator('#folderName .sc-name')).toBeVisible();   // booted onto the (fresh) map
}

export function card(page: Page, text: string): Locator {
  return page.locator('#world .node', { hasText: text }).first();
}
export function section(page: Page, text: string): Locator {
  return page.locator('#world .node.section', { hasText: text }).first();
}

// What a node's tooltip says. A folded section writes its own as the pointer comes in (main.ts nodeEl), so
// come in from somewhere else first.
export async function tooltip(page: Page, l: Locator): Promise<string | null> {
  await page.mouse.move(AWAY.x, AWAY.y);
  await l.hover();
  return l.getAttribute('title');
}

export async function clickAway(page: Page): Promise<void> {
  await page.mouse.click(AWAY.x, AWAY.y);
  await expect(page.locator('textarea.body-edit')).toHaveCount(0);
}

// N with the pointer at (x, y) makes a card there and opens it for typing. `text` is INSERTED rather
// than typed, so it lands verbatim: a typed Enter after a list item would continue the list
// (utils/md-edit.ts listEnter) and double every marker. It may hold several lines.
export async function makeCard(page: Page, x: number, y: number, text: string): Promise<Locator> {
  await page.mouse.move(x, y);
  await page.keyboard.press('n');
  await expect(page.locator('textarea.body-edit')).toBeFocused();
  await page.keyboard.insertText(text);
  await clickAway(page);
  const first = text.split('\n')[0].replace(/^#\s*/, '');
  await expect(card(page, first)).toBeVisible();
  // pinned to its id, not its text: while the card is being edited its text lives in a textarea's
  // value, which a text match can't see
  const id = await card(page, first).getAttribute('data-id');
  await settled(page);
  return page.locator(`#world .node[data-id="${id}"]`);
}

// An element's centre on screen.
export async function centre(l: Locator): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Press at `from`, carry it to `to` (screen points) and let go; `hold` rests there first — what a person does
// to say "this one, onto that".
export async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number },
                             { hold = 0 }: { hold?: number } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  if (hold) {
    await page.waitForTimeout(hold);
  }
  await page.mouse.up();
  await settled(page);
}

// …from one element's centre onto another's.
export async function dragOnto(page: Page, what: Locator, onto: Locator): Promise<void> {
  await dragTo(page, await centre(what), await centre(onto));
}

// Make `c` the one selection. A click on the card that ALREADY is opens its editor (main.ts editOnClick),
// so then there is nothing to click.
export async function select(page: Page, c: Locator): Promise<void> {
  if (await c.evaluate(el => el.classList.contains('solo'))) {
    return;
  }
  const b = (await c.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await settled(page);
}

export type Side = 'up' | 'down' | 'left' | 'right';
// Click the selected card's port on `side` where a person would: on the dot (which is drawn over the
// port's own hit circle, so a locator click would be refused as "intercepted").
export async function clickPort(page: Page, side: Side): Promise<void> {
  const p = (await page.locator(`g.fe-socket[data-socket="${side}"] .fe-port-hit`).boundingBox())!;
  await page.mouse.click(p.x + p.width / 2, p.y + p.height / 2);
  await settled(page);
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
  await settled(page);
}

export async function palette(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+p');
  await page.locator('#palInput').fill(command);
  await page.keyboard.press('Enter');
  await expect(page.locator('#palInput')).toBeHidden();
  await settled(page);
}

// Survive a reload: wait out the debounced autosave first.
export async function reload(page: Page): Promise<void> {
  await saved(page);
  await page.reload();
  await expect(page.locator('#folderName .sc-name')).toBeVisible();   // booted back onto the map
  await settled(page);
}

// Write a whole map straight into the board's OPFS folder and reload onto it — for scenes (nested
// sections, saved states) that would take a page of gestures to build by hand. A first card is made so
// the map's folder exists, then everything in it is replaced.
export async function seedBoard(page: Page, files: Record<string, string>): Promise<void> {
  await makeCard(page, 300, 300, 'seed');
  await saved(page);   // …and its save has landed, so nothing is still writing the files we replace
  await page.evaluate(async (files) => {
    async function find(d: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | undefined> {
      for await (const [n, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (h.kind === 'directory') {
          const r = await find(h as FileSystemDirectoryHandle);
          if (r) {
            return r;
          }
        } else if (n === 'board.json' || n.endsWith('.md')) {
          return d;
        }
      }
      return undefined;
    }
    const dir = (await find(await navigator.storage.getDirectory()))!;
    // the map's notes, board and section FOLDERS go; the map's own meta file stays
    for await (const [n, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      if (n.endsWith('.md') || n === 'board.json' || h.kind === 'directory') {
        await dir.removeEntry(n, { recursive: true });
      }
    }
    for (const [name, text] of Object.entries(files)) {
      const parts = name.split('/');
      let d = dir;
      for (const p of parts.slice(0, -1)) {
        d = await d.getDirectoryHandle(p, { create: true });
      }
      const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(text); await w.close();
    }
  }, files);
  await page.reload();
  await expect(page.locator('#folderName .sc-name')).toBeVisible();     // booted back onto the map…
  await expect(page.locator('#world .node').first()).toBeAttached();   // …and the seeded map is on the canvas
  await page.keyboard.press('f');   // fit the seeded map
  await settled(page);
}

export function note(body: string, fm: Record<string, string> = {}): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  if (!lines.length) {
    return `${body}\n`;   // no frontmatter at all, the way a hand-written note has none
  }
  return `---\n${lines.join('\n')}\n---\n\n${body}\n`;
}

// Collect uncaught page errors and console errors; a spec asserts the list is empty at the end.
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error') {
      errors.push(m.text());
    }
  });
  return errors;
}

// Every file of the open map on disk (OPFS), path → text — what a section-as-folder test reads back.
export async function diskFiles(page: Page): Promise<Record<string, string>> {
  await saved(page);
  return page.evaluate(async () => {
    async function find(d: FileSystemDirectoryHandle): Promise<FileSystemDirectoryHandle | undefined> {
      for await (const [n] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (n === 'board.json') {
          return d;
        }
      }
      for await (const [, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (h.kind === 'directory') {
          const r = await find(h as FileSystemDirectoryHandle);
          if (r) {
            return r;
          }
        }
      }
      return undefined;
    }
    const out: Record<string, string> = {};
    async function walk(d: FileSystemDirectoryHandle, prefix: string): Promise<void> {
      for await (const [n, h] of (d as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (h.kind === 'directory') {
          await walk(h as FileSystemDirectoryHandle, prefix + n + '/');
        } else if (n.endsWith('.md')) {
          out[prefix + n] = await (await (h as FileSystemFileHandle).getFile()).text();
        }
      }
    }
    await walk((await find(await navigator.storage.getDirectory()))!, '');
    return out;
  });
}
