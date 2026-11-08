// Export the board, or the selection, as a picture: PNG, SVG or PDF.
// The canvas DOM is cloned into an SVG <foreignObject> together with the page's own CSS, so the picture is
// drawn by the very rules that draw the screen: no second renderer to drift. The SVG is that clone as is
// (it shows in browsers; design tools that don't read <foreignObject> see nothing). PNG draws it into a
// canvas; PDF wraps that canvas as a JPEG page (utils/pdf.ts), so its text is pixels, not type.
import { state, world, stage, setStatus, type MindNode } from '../core/state.js';
import { ancestors, isHidden } from '../utils/model.js';
import { store } from '../data/persistence.js';
import { downloadBlob } from '../utils/download.js';
import { safeName } from '../utils/filenames.js';
import { jpegPdf } from '../utils/pdf.js';
import { edgeEnd } from '../view/free-edges.js';
import { canvasSurface } from './canvas-color.js';

export type ImageFormat = 'png' | 'svg' | 'pdf';

interface Picture { svg: string; w: number; h: number; }

const PAD = 32;
const SCALE = 2;                             // a retina-sharp PNG
const MAX_SIDE = 16384, MAX_AREA = 1.6e8;    // past these, browsers hand back a blank canvas
const XHTML = 'http://www.w3.org/1999/xhtml';

export async function exportImage(format: ImageFormat): Promise<void> {
  const pic = await picture();
  if (!pic) {
    setStatus('Nothing to export');
    return;
  }
  const name = safeName(store.name || 'corkboard') + '.' + format;
  if (format === 'svg') {
    downloadBlob(new Blob([pic.svg], { type: 'image/svg+xml' }), name);
    return;
  }
  const canvas = await rasterize(pic);
  if (format === 'png') {
    downloadBlob(await toBlob(canvas, 'image/png'), name);
    return;
  }
  const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
  const pdf = jpegPdf(jpeg, canvas.width, canvas.height, pic.w * 0.75, pic.h * 0.75);   // CSS px → pt
  downloadBlob(new Blob([pdf as BlobPart], { type: 'application/pdf' }), name);
}

// What's on the canvas, or only the selection and what it holds, cropped to it.
async function picture(): Promise<Picture | null> {
  const sel = state.sel;
  const inSel = (n: MindNode): boolean => sel.has(n.id) || [...ancestors(n)].some(a => sel.has(a.id));
  const kept = [...state.nodes.values()].filter(n => n.el && !isHidden(n) && (sel.size === 0 || inSel(n)));
  if (!kept.length) {
    return null;
  }
  const ids = new Set(kept.map(n => n.id));
  const box = worldBox(kept);
  const w = Math.ceil(box.x1 - box.x0 + 2 * PAD), h = Math.ceil(box.y1 - box.y0 + 2 * PAD);

  const clone = world.cloneNode(true) as HTMLElement;
  clone.style.transform = `translate(${PAD - box.x0}px,${PAD - box.y0}px)`;
  clone.style.willChange = 'auto';
  clone.querySelectorAll('#freeEdgeHits, #toggles, .fe-lines > :not(g[data-edge]), .fe-selring').forEach(e => e.remove());
  clone.querySelectorAll('.sel, .solo, .search-dim').forEach(e => e.classList.remove('sel', 'solo', 'search-dim'));
  if (sel.size) {

    // visibility, not removal: a selected card inside an unselected section must still show
    clone.querySelectorAll<HTMLElement>('[data-id]').forEach(e => { e.style.visibility = ids.has(e.dataset.id ?? '') ? 'visible' : 'hidden'; });
    const edges = new Map(state.edges.map(e => [e.id, e]));
    clone.querySelectorAll<SVGGElement>('g[data-edge]').forEach(g => {
      const e = edges.get(g.dataset.edge ?? '');
      if (!e || !ids.has(edgeEnd(e.from)?.id ?? '') || !ids.has(edgeEnd(e.to)?.id ?? '')) {
        g.remove();
      }
    });
  }
  await Promise.all([...clone.querySelectorAll('img')].map(inlineImage));

  const root = document.createElementNS(XHTML, 'div') as HTMLElement;
  const body = getComputedStyle(document.body);
  root.style.cssText = stage.style.cssText;   // the canvas colour's custom properties live on #stage
  Object.assign(root.style, { position: 'relative', width: `${w}px`, height: `${h}px`, overflow: 'hidden',
    background: canvasSurface(), fontFamily: body.fontFamily, color: body.color });
  const style = document.createElementNS(XHTML, 'style');
  style.textContent = pageCss();
  root.append(style, clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(root)}</foreignObject></svg>`;
  return { svg, w, h };
}

// In world units. Every descendant counts: tags and a section's label sit outside the node's own box.
function worldBox(nodes: MindNode[]): { x0: number; y0: number; x1: number; y1: number } {
  const o = world.getBoundingClientRect(), k = state.view.k;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    for (const el of [n.el!, ...n.el!.querySelectorAll('*')]) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) {
        continue;
      }
      x0 = Math.min(x0, (r.left - o.left) / k); y0 = Math.min(y0, (r.top - o.top) / k);
      x1 = Math.max(x1, (r.right - o.left) / k); y1 = Math.max(y1, (r.bottom - o.top) / k);
    }
  }
  return { x0, y0, x1, y1 };
}

// An SVG drawn as an image may not fetch anything, so a picture must travel inside it.
async function inlineImage(img: HTMLImageElement): Promise<void> {
  if (!img.src || img.src.startsWith('data:')) {
    return;
  }
  try {
    const blob = await (await fetch(img.src)).blob();
    img.src = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {

    // a cross-origin picture without CORS can't be read: it exports as an empty frame
  }
}

function pageCss(): string {
  let css = '';
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        css += rule.cssText + '\n';
      }
    } catch {

      // a cross-origin stylesheet can't be read; the app has none of its own
    }
  }
  return css;
}

async function rasterize(pic: Picture): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pic.svg);
  await img.decode();
  const s = Math.min(SCALE, MAX_SIDE / pic.w, MAX_SIDE / pic.h, Math.sqrt(MAX_AREA / (pic.w * pic.h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pic.w * s);
  canvas.height = Math.round(pic.h * s);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Export failed'))), type, quality));
}
