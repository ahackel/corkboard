// ---------- resize: the handles on a selected card or section, and dragging them ----------
import { NODE_W, imageLook, IMAGE_FOLD, IMAGE_W, IMAGE_H, isBoxNode, nodeW, nodeH, gridSnap } from '../view/geometry.js';
import { type MindNode, state } from '../core/state.js';
import { isLockedEffective, subtreeIds } from '../utils/model.js';
import { ui } from '../core/ui-state.js';
import { touch, commitStep } from './history.js';
import { snapTo } from '../utils/num.js';
import { guideResize, hideGuides } from './guides.js';
import { paintNode, relayout } from '../main.js';
import { paintFreeEdges } from '../view/free-edges.js';
import { settleSections } from './drag.js';
import { growSectionsToHold, syncFloatBar } from './float-bar.js';
import { trackPointer } from '../utils/dom.js';
import { scheduleSave } from '../data/save.js';

// a section is never narrower than a normal card
export const MIN_SECTION_W = NODE_W, MIN_SECTION_H = 120;
// An image card's floor is the ICON it becomes: drag either axis to IMAGE_FOLD and the card folds
// (startNodeResize below), so there is no smaller expanded size to clamp at.
// A width-only kind can only ever get WIDER than the width it has by default — the whole point is
// trading height for width on a card whose text wraps badly, so its natural size is the floor. That
// floor is NODE_W for a plain card and a section alike, so they share the one fall-through.
function minWOf(n: MindNode): number {
  return imageLook(n) ? IMAGE_FOLD : NODE_W;
}
// The shortest a CLIPPED card goes: about one line of text under its padding.
const CLIP_MIN_H = 44;

function minHOf(n: MindNode): number {
  return imageLook(n) ? IMAGE_FOLD : MIN_SECTION_H;
}
// 8 resize handles: 4 edges (one axis) + 4 corners (two axes). A `w`/`n` component moves that edge,
// which shifts the section's x/y (the opposite edge stays put); `e`/`s` just grow width/height.
export const SECTION_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type SectionDir = typeof SECTION_DIRS[number];
// Ensure the node has exactly the resize hit-zones its kind wants — one per edge/corner, added once
// and reused. The corners of a lone selection draw FigJam's square handles (styles.css); the edges
// have no grip, their resize cursor is the affordance.
// `:scope >` throughout, NOT a descendant query: child cards are DOM-nested inside their parent
// (see place/settledHost), so a plain card containing a nested image card would otherwise see the
// CHILD's handles, conclude it already had its own, and never get any.
export function ensureResizeHandles(n: MindNode, dirs: readonly SectionDir[]): void {
  const el = n.el!;
  const key = dirs.join('');
  if (el.dataset.fhDirs === key) {
    return;   // keyed by the direction SET, so a type flip rebuilds
  }
  clearResizeHandles(el);
  for (const dir of dirs) {
    const h = document.createElement('div');
    h.className = 'fh fh-' + dir;
    h.addEventListener('pointerdown', (e) => startNodeResize(e as PointerEvent, n, dir));
    el.appendChild(h);
  }
  el.dataset.fhDirs = key;
}
export function clearResizeHandles(el: HTMLElement): void {
  if (!el.dataset.fhDirs) {
    return;   // no handles to remove — skip the query, this runs every repaint
  }
  el.querySelectorAll(':scope > .fh').forEach(x => x.remove());
  delete el.dataset.fhDirs;
}
// Drag an edge/corner to resize. Work in edge coordinates (left/top/right/bottom) so the edges NOT
// being dragged stay fixed; the dragged edges snap to the grid and clamp to the min size. Top/left
// edges moving means the section's x/y move too. Children inside are free, so only the parent's own
// layout reflows around the section — done once on release, not every move.
// An image card's aspect ratio (width/height): the actual loaded image if hydrateImages has
// resolved it, else whatever the box currently shows (so an in-progress resize is stable even
// before the blob URL loads).
function imageAspect(n: MindNode): number {
  const img = n.el?.querySelector('img.md-img') as HTMLImageElement | null;
  if (img && img.naturalWidth && img.naturalHeight) {
    return img.naturalWidth / img.naturalHeight;
  }
  const w = n.w ?? IMAGE_W, h = n.h ?? IMAGE_H;
  return w / (h || 1);
}
function startNodeResize(e: PointerEvent, n: MindNode, dir: SectionDir): void {
  if (state.readOnly || isLockedEffective(n)) {
    return;
  }
  e.stopPropagation(); e.preventDefault();
  // Is this a BOX (its size is exactly what's dragged) or a card (its height is a minimum over what
  // its text measures)? A FOLDED image card counts as a box here even though isBoxNode says no: its
  // 40px icon is the small end of its own size range, and scaling it back up is how you unfold it.
  const img = imageLook(n);
  const sizeH = isBoxNode(n) || img;
  const minW = minWOf(n);
  // A card's text height at the width it starts from is where its min-height stops and its clip starts.
  // (A clipped card's body cap is lifted too, or it would measure as its own clip.)
  const natural = (): number => {
    const el = n.el!, body = el.querySelector(':scope > .body') as HTMLElement;
    const was = el.style.minHeight, wasMax = body.style.maxHeight;
    el.style.minHeight = ''; body.style.maxHeight = ''; const h = el.offsetHeight;
    el.style.minHeight = was; body.style.maxHeight = wasMax;
    return h;
  };
  // …but it CAN be dragged shorter than that, down to a line: then it CLIPS (n.clip) instead of growing.
  const natural0 = sizeH ? 0 : natural();
  const minH = sizeH ? minHOf(n) : Math.min(natural0, CLIP_MIN_H);
  const aspect = img ? imageAspect(n) : null;   // width/height — locked while dragging an image card
  // Live geometry, not (n.w ?? boxDefaultW): boxDefaultH falls back to SECTION_H for anything that
  // isn't an image/query, so a plain card would start from a bogus 279px-tall box.
  const left0 = n.x, top0 = n.y, right0 = n.x + nodeW(n), bottom0 = n.y + nodeH(n);
  const sx = e.clientX, sy = e.clientY;
  ui.resizingId = n.id; n.el?.classList.add('resizing');   // its tags step aside while its edge moves (paintNode keeps it)
  const west = dir.includes('w'), east = dir.includes('e'), north = dir.includes('n'), south = dir.includes('s');
  touch(n.id);
  let lastDx = 0, lastDy = 0;
  let subtreeRAF: number | null = null;
  const g = gridSnap();
  // The grid on the SIZE — the same snap a dragged card gets (utils/num.ts), live
  // on every move, so the box steps between grid sizes under the pointer instead of taking one up at
  // the end. One snapping rule for everything the pointer moves.
  const snap = (v: number): number => snapTo(v, g);
  // Apply the current drag delta, keeping the non-dragged edges fixed. We snap the SIZE (not the
  // edges) to the grid so a box's w/h are always multiples of the snap — the moving edge derives
  // from the fixed opposite edge minus the snapped size. Free (unsnapped) while dragging; snapped
  // on release. Clamped to the min size (also grid multiples).
  const resize = (round: (v: number) => number): void => {
    let left = left0, right = right0, top = top0, bottom = bottom0;
    if (aspect) {
      // Image card: whichever axis the user is actually dragging drives the size (grid-snapped);
      // the other axis is DERIVED from the image's own aspect ratio rather than dragged/snapped
      // independently. A corner drags both — drive by whichever axis implies the bigger relative
      // change, so the drag feels proportionate regardless of which corner is grabbed.
      const w0 = right0 - left0, h0 = bottom0 - top0;
      const hasX = east || west, hasY = north || south;
      let w = w0, h = h0;
      const wDragged = Math.max(minW, round(w0 + (east ? lastDx : -lastDx)));
      const hDragged = Math.max(minH, round(h0 + (south ? lastDy : -lastDy)));
      const byWidth = hasX && (!hasY || Math.abs(wDragged - w0) * h0 >= Math.abs(hDragged - h0) * w0);
      if (byWidth) {
        w = wDragged;
        h = Math.max(minH, w / aspect);
      } else if (hasY) {
        h = hDragged;
        w = Math.max(minW, h * aspect);
      }
      left = west ? right0 - w : left0;  right = left + w;
      top  = north ? bottom0 - h : top0; bottom = top + h;
    } else {
      // Smart guides pull the DRAGGED edge (features/guides.ts), read off the RAW pointer like a move's,
      // and win over the grid on an axis where they line something up; the grid has the other axis.
      const pull = guideResize(n, {
        x: west ? left0 + lastDx : left0, y: north ? top0 + lastDy : top0,
        w: (east ? right0 + lastDx : right0) - (west ? left0 + lastDx : left0),
        h: (south ? bottom0 + lastDy : bottom0) - (north ? top0 + lastDy : top0),
      }, { x: west ? 'lo' : east ? 'hi' : undefined, y: north ? 'lo' : south ? 'hi' : undefined });
      const px = pull.x ?? 0, py = pull.y ?? 0;
      const rx = pull.x != null ? (v: number): number => v : round, ry = pull.y != null ? (v: number): number => v : round;
      if (east)  { const w = Math.max(minW, rx(right0 + lastDx + px - left0));  right = left0 + w; }
      if (west)  { const w = Math.max(minW, rx(right0 - (left0 + lastDx + px))); left = right0 - w; }
      if (south) { const h = Math.max(minH, ry(bottom0 + lastDy + py - top0));   bottom = top0 + h; }
      if (north) { const h = Math.max(minH, ry(bottom0 - (top0 + lastDy + py))); top = bottom0 - h; }
    }
    // An image card FOLDS by being scaled down and unfolds by being scaled up — the third fold
    // control beside the chip and `X`, and the only one that is also a size. The threshold is the icon
    // itself: once the SHORT axis is down to IMAGE_FOLD the card is icon-sized, so it becomes one, and
    // dragging back out past that restores it. Live, so the icon appears and goes under the cursor.
    // While folded the authored w/h are left ALONE — they're the size it comes back to, whether that's
    // this same drag reversing or the chip unfolding it tomorrow.
    if (aspect) {
      const fold = Math.min(right - left, bottom - top) <= IMAGE_FOLD;
      if (fold !== n.collapsed) {
        n.collapsed = fold;
      }
      if (fold) { n.dirty = true; return; }
    }
    n.x = left; n.w = right - left;
    if (sizeH || north || south) {
      n.y = top;
      n.h = bottom - top;
      if (!sizeH) {
        n.clip = n.h < natural0 - 1 || undefined;
      }
    }
    n.dirty = true;
  };
  const move = (ev: PointerEvent): void => {
    lastDx = (ev.clientX - sx) / state.view.k; lastDy = (ev.clientY - sy) / state.view.k;
    resize(snap);
    paintNode(n);
    paintFreeEdges();
    // A width-only kind re-wraps its text at the new width, which changes its measured HEIGHT — let
    // everything that reads it (edges, the selection bar) settle as the drag goes, once per section.
    if (!sizeH && !subtreeRAF) {
      subtreeRAF = requestAnimationFrame(() => {
        subtreeRAF = null;
        relayout();
      });
    }
    // A north/west resize shifts the section's own x/y, which shifts its content wrapper's origin —
    // repaint the whole subtree (not just direct children) so every hosted descendant's live,
    // wrapper-relative position compensates and stays put in absolute space as the box resizes
    // around it (an east/south-only resize doesn't move the origin, so this is skipped entirely).
    // subtreeIds walks the whole node map, so coalesce it to once per animation frame rather than
    // once per raw pointermove (which can fire far faster than the screen repaints).
    else if ((north || west) && !subtreeRAF) {
      subtreeRAF = requestAnimationFrame(() => {
        subtreeRAF = null;
        for (const id of subtreeIds(n.id)) {
          const k = state.nodes.get(id);
          if (k) {
            paintNode(k);
          }
        }
      });
    }
  };
  const up = (): void => {
    stop();
    ui.resizingId = null; n.el?.classList.remove('resizing');
    if (subtreeRAF) { cancelAnimationFrame(subtreeRAF); subtreeRAF = null; }
    resize(snap);   // the final delta; the size was already on the grid throughout
    hideGuides();
    // Back at (or under) the natural width → drop the authored width entirely rather than persisting
    // a redundant mm_w on every card the user so much as nudges.
    if (!sizeH && n.w != null && Math.round(n.w) <= minW) {
      n.w = undefined;
    }
    // …and the same for a card's height: no taller than its text → it has no authored height.
    // Shorter than its text (at the width it ended at) → it clips; else it's a minimum again.
    if (!sizeH && n.h != null) {
      paintNode(n);
      const nat = natural();
      if (Math.round(n.h) < nat - 1) {
        n.clip = true;
      } else {
        n.clip = undefined;
        if (Math.round(n.h) <= nat + 1) {
          n.h = undefined;
        }
      }
    }
    // paint BEFORE anything reads it: a width-only node's height only matches the snapped width once
    // the DOM has it.
    paintNode(n);
    // NB a west/north drag also moves this node's own x/y, which restales every CHILD's persisted
    // offset — commitRel handles that centrally for every mover, so there's nothing to do here.
    // A resized SECTION takes in what it now covers and lets go of what it no longer does
    // (settleSections). It isn't grown back around what it took in — the user just chose its size —
    // but a card it let go of grows the section it landed in, as any drop does.
    if (n.type === 'section') {
      const released = settleSections([n.id]).filter(id => state.nodes.get(id)?.parent !== n.id);
      growSectionsToHold(released);
    }
    relayout(); scheduleSave(); commitStep();
    syncFloatBar();   // a card that now has an authored height offers Fit (↔)
  };
  const stop = trackPointer({ move, up });
}
