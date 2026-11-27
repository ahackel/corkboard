// ⌥-drag an inline image OUT of a card (started by bindNodeDrag): it moves into the card it is
// dropped on, else becomes an image card where it lands. Cancel or a no-move press changes nothing.
import { state, type MindNode } from '../core/state.js';
import { ui } from '../core/ui-state.js';
import { nodeAtTarget, takesDrop } from '../utils/model.js';
import { screenToWorld } from '../view/camera.js';
import { extractImage } from './crud.js';
import { classMarker, trackPointer } from '../utils/dom.js';
import { IMAGE_W, IMAGE_H, snapPt } from '../view/geometry.js';

// A card is natively `draggable` (⌥-drag exports a .md); that dragstart bails while this is true,
// or it would hijack the gesture.
export function imageExtractInProgress(): boolean { return ui.extracting; }

const setHover = classMarker('drop-merge');
const PREVIEW_W = 140;
const PREVIEW_MIN_H = 40;
const MOVE_THRESHOLD_PX = 3;

// The preview is hidden for the hit-test so it never shadows the card beneath.
function moveTargetAt(x: number, y: number, sourceId: string, preview: HTMLElement): { el: HTMLElement; id: string } | null {
  preview.style.display = 'none';
  const under = document.elementFromPoint(x, y) as HTMLElement | null;
  preview.style.display = '';
  const node = nodeAtTarget(under);
  if (!takesDrop(node) || !node.el || node.id === sourceId) {
    return null;
  }
  return { el: node.el, id: node.id };
}

export function startImageExtractDrag(source: MindNode, img: HTMLImageElement, sx: number, sy: number): void {
  if (state.singleNote) {
    return;
  }
  const path = img.dataset.path;
  if (!path) {
    return;
  }
  ui.extracting = true;
  const alt = img.alt || '';
  const nw = img.naturalWidth || IMAGE_W, nh = img.naturalHeight || IMAGE_H;
  const cardW = Math.round(Math.min(IMAGE_W, nw));
  const cardH = Math.round(cardW * (nh / nw)) || IMAGE_H;
  const pw = PREVIEW_W, ph = Math.max(PREVIEW_MIN_H, Math.round(pw * (nh / nw)));
  const preview = document.createElement('div');
  preview.className = 'image-extract-preview';
  preview.style.width = pw + 'px'; preview.style.height = ph + 'px';
  const pimg = document.createElement('img'); pimg.src = img.src; preview.appendChild(pimg);
  document.body.appendChild(preview);
  const place = (x: number, y: number): void => { preview.style.left = (x - pw / 2) + 'px'; preview.style.top = (y - ph / 2) + 'px'; };
  place(sx, sy);
  document.body.classList.add('grabbing', 'grab-all');
  let moved = false;
  const cleanup = (): void => {
    stop();
    setHover(null); preview.remove();
    document.body.classList.remove('grabbing', 'grab-all');
    ui.extracting = false;
  };
  const onMove = (ev: PointerEvent): void => {
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > MOVE_THRESHOLD_PX) {
      moved = true;
    }
    place(ev.clientX, ev.clientY);
    setHover(moveTargetAt(ev.clientX, ev.clientY, source.id, preview)?.el ?? null);
  };
  const onUp = (ev: PointerEvent): void => {
    const t = moveTargetAt(ev.clientX, ev.clientY, source.id, preview);
    cleanup();
    if (!moved) {
      return;
    }
    if (t) {
      extractImage(source.id, path, alt, { toCardId: t.id });
    } else {
      const p = screenToWorld(ev.clientX, ev.clientY);
      const at = snapPt({ x: p.x - cardW / 2, y: p.y - cardH / 2 });
      extractImage(source.id, path, alt, { x: at.x, y: at.y, w: cardW, h: cardH });
    }
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      cleanup();
    }
  };
  const stop = trackPointer({ move: onMove, up: onUp, cancel: cleanup, key: onKey });
}
