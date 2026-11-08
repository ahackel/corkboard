// Export the board, or the selection, as a picture: PNG or PDF.
// The canvas DOM is cloned into an SVG <foreignObject> together with the page's own CSS, so the picture is
// drawn by the very rules that draw the screen: no second renderer to drift. PNG draws that SVG into a
// canvas; PDF wraps the canvas as a JPEG page (utils/pdf.ts), so its text is pixels, not type.
// No SVG export: that SVG renders differently in every viewer (WebKit blows up emoji, design tools show
// nothing), and a true vector one would need a second renderer.
// The picture is cropped tight to what it shows, with no canvas behind it: transparent, except in the PDF,
// where a JPEG can't be and the page is white paper.
import { state, world, stage, setStatus, type MindNode } from '../core/state.js';
import { ancestors, isHidden } from '../utils/model.js';
import { store } from '../data/persistence.js';
import { downloadBlob } from '../utils/download.js';
import { safeName } from '../utils/filenames.js';
import { jpegPdf } from '../utils/pdf.js';
import { edgeEnd } from '../view/free-edges.js';
import { xmlSafe } from '../utils/markdown.js';

export type ImageFormat = 'png' | 'pdf';

interface Picture { svg: string; w: number; h: number; }

const SCALE = 2;                             // a retina-sharp PNG
const MAX_SIDE = 16384, MAX_AREA = 1.6e8;    // past these, browsers hand back a blank canvas
const XHTML = 'http://www.w3.org/1999/xhtml';
const GRIPS = '.fh';                        // a card's invisible resize grips, which reach past its edge

export async function exportImage(format: ImageFormat): Promise<void> {
  const pic = await picture();
  if (!pic) {
    setStatus('Nothing to export');
    return;
  }
  const name = safeName(store.name || 'corkboard') + '.' + format;
  if (format === 'png') {
    downloadBlob(await toBlob(await rasterize(pic), 'image/png'), name);
    return;
  }
  const canvas = await rasterize(pic, '#fff');
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
  const edges = new Map(state.edges.map(e => [e.id, e]));
  const keepLine = (g: SVGGElement): boolean => {
    const e = edges.get(g.dataset.edge ?? '');
    return sel.size === 0 || (!!e && ids.has(edgeEnd(e.from)?.id ?? '') && ids.has(edgeEnd(e.to)?.id ?? ''));
  };
  const lines = [...world.querySelectorAll<SVGGElement>('.fe-lines g[data-edge]')].filter(keepLine);
  const box = worldBox([...kept.map(n => n.el!), ...lines]);
  const w = Math.ceil(box.x1 - box.x0), h = Math.ceil(box.y1 - box.y0);

  const clone = world.cloneNode(true) as HTMLElement;
  clone.style.transform = `translate(${-box.x0}px,${-box.y0}px)`;
  clone.style.willChange = 'auto';
  clone.querySelectorAll(`#freeEdgeHits, #toggles, .fe-lines > :not(g[data-edge]), .fe-selring, ${GRIPS}`).forEach(e => e.remove());
  clone.querySelectorAll('.sel, .solo, .search-dim').forEach(e => e.classList.remove('sel', 'solo', 'search-dim'));
  if (sel.size) {

    // visibility, not removal: a selected card inside an unselected section must still show
    clone.querySelectorAll<HTMLElement>('[data-id]').forEach(e => { e.style.visibility = ids.has(e.dataset.id ?? '') ? 'visible' : 'hidden'; });
    clone.querySelectorAll<SVGGElement>('g[data-edge]').forEach(g => {
      if (!keepLine(g)) {
        g.remove();
      }
    });
  }
  await Promise.all([...clone.querySelectorAll('img')].map(inlineImage));

  const root = document.createElementNS(XHTML, 'div') as HTMLElement;
  const body = getComputedStyle(document.body);
  root.style.cssText = stage.style.cssText;   // the canvas colour's custom properties live on #stage
  Object.assign(root.style, { position: 'relative', width: `${w}px`, height: `${h}px`, overflow: 'hidden',
    fontFamily: body.fontFamily, color: body.color });
  const style = document.createElementNS(XHTML, 'style');
  style.textContent = pageCss();
  root.append(style, clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<foreignObject width="100%" height="100%">${xmlSafe(new XMLSerializer().serializeToString(root))}</foreignObject></svg>`;
  return { svg, w, h };
}

// In world units. Every descendant counts: tags and a section's label sit outside the node's own box.
function worldBox(els: Element[]): { x0: number; y0: number; x1: number; y1: number } {
  const o = world.getBoundingClientRect(), k = state.view.k;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const top of els) {
    for (const el of [top, ...top.querySelectorAll('*')]) {
      const r = el.getBoundingClientRect();
      if ((!r.width && !r.height) || el.matches(GRIPS) || (el !== top && !paints(el))) {
        continue;
      }
      x0 = Math.min(x0, (r.left - o.left) / k); y0 = Math.min(y0, (r.top - o.top) / k);
      x1 = Math.max(x1, (r.right - o.left) / k); y1 = Math.max(y1, (r.bottom - o.top) / k);
    }
  }
  return { x0, y0, x1, y1 };
}

// Does this part of a card draw anything? An empty slot (a card's tag strip with no tags) still has a box,
// and that box reaching past the card's edge would pad the crop.
function paints(el: Element): boolean {
  return el instanceof SVGElement || !!el.textContent?.trim() || !!el.querySelector('img, svg');
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

async function rasterize(pic: Picture, fill?: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pic.svg);
  await img.decode();
  const s = Math.min(SCALE, MAX_SIDE / pic.w, MAX_SIDE / pic.h, Math.sqrt(MAX_AREA / (pic.w * pic.h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(pic.w * s);
  canvas.height = Math.round(pic.h * s);
  const ctx = canvas.getContext('2d')!;
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Export failed'))), type, quality));
}
