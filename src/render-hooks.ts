// What the render core asks of the features above it, since it never imports them. main.ts fills these in
// first; until then each does nothing, so painting works without a single feature loaded.
import { type MindNode } from './core/state.js';
import { type ShownTag } from './utils/tags.js';

export interface RenderHooks {
  // Once per element: every press, click and key it answers.
  bindNode(n: MindNode, el: HTMLElement): void;

  showResizeHandles(n: MindNode, on: boolean): void;
  paintPile(n: MindNode, el: HTMLElement): void;
  hydrateImages(body: HTMLElement, noteFile: string | null | undefined): void;
  paintTagRow(row: HTMLElement, id: string, tags: ShownTag[]): void;

  searchTags(): readonly string[];
  searchHitsIn(id: string): number;

  // Around every paintAll: before the nodes, after them, and after the lines.
  beforePaint(): void;
  afterNodes(): void;
  afterLines(): void;

  syncSelFrame(): void;
}

export const renderHooks: RenderHooks = {
  bindNode: () => {},
  showResizeHandles: () => {},
  paintPile: () => {},
  hydrateImages: () => {},
  paintTagRow: () => {},
  searchTags: () => [],
  searchHitsIn: () => 0,
  beforePaint: () => {},
  afterNodes: () => {},
  afterLines: () => {},
  syncSelFrame: () => {},
};

export function installRenderHooks(hooks: RenderHooks): void {
  Object.assign(renderHooks, hooks);
}
