// ---------- annotation tethers ----------
// This module used to own the parent→child CONNECTOR geometry — the branch lines of a mind map, in
// three styles, fanning out of a socket on each of a card's four sides. None of that exists any
// more: a child lives INSIDE its parent now (view/layout.ts isStack), so there is nothing to span
// and no side to span it from (docs/spec-edges-and-containment.md).
//
// What is left is the one line that was never a branch: an ANNOTATION's tether. An annotation is a
// remark pinned on top of the card it comments on, at a spot the user dragged it to — it takes no
// part in layout, so the dotted line to its parent is the only thing saying which card it belongs
// to. It is drawn in its own colour, never clipped, and it rides the overlay above the cards.
//
// The edges the user DRAWS are a different thing entirely and live in view/free-edges.ts.
import { state, edgesSvg, dragEdgesSvg, dragLayerEdges, isAnnotation, type MindNode } from '../core/state.js';
import { isHidden, parentOf } from '../utils/model.js';
import { ui } from '../core/ui-state.js';
import { nodeW, nodeH, elTop, effectiveColor, colorFill } from '../main.js';
import { clamp } from '../utils/num.js';
import { paintFreeEdges } from './free-edges.js';

const DOT_R = 5;   // the anchor disk where a tether meets the card it annotates

// Paints EVERY line on the canvas: the annotation tethers below, and then the free edges. The two
// are one call because every caller wants both — a card moving under a drag moves its tether AND its
// edges, and there are a dozen repaint sites (drag frames, auto-pan, layout animation) that would
// otherwise each have to remember the second one. Free edges go LAST: both write the #toggles
// overlay and that layer is theirs.
export function paintEdges(): void {
  paintTethers();
  paintFreeEdges();
}
function paintTethers(): void {
  // While filtering, hide the tethers: dimmed cards are semi-transparent, so faint lines would
  // show through them and read as clutter.
  if (state.searchMatch){ edgesSvg.innerHTML = ''; dragEdgesSvg.innerHTML = ''; dragLayerEdges.innerHTML = ''; return; }
  let annos = '';     // tethers, on the above-cards overlay (unclipped)
  let dragged = '';   // …and the ones belonging to items being dragged, inside the drag opacity group
  const inDragGroup = (id: string): boolean => !!(ui.drag && ui.drag.moved && ui.drag.targets.has(id));
  for (const n of state.nodes.values()) {
    if (!isAnnotation(n)) continue;
    const parent = parentOf(n);
    if (!parent) continue;
    if (isHidden(parent) || isHidden(n)) continue;
    // A ripped / re-pinned annotation drops its old tether while the drag is live — the dashed
    // outline on the candidate parent shows the pending result instead.
    if (ui.drag && ui.drag.alt && !ui.drag.shift && ui.drag.n.id === n.id) continue;
    if (ui.drag && ui.drag.dropTarget && ui.drag.targets.has(n.id) && !ui.drag.targets.has(parent.id)) continue;
    if (ui.drag && ui.drag.cloned && ui.drag.targets.has(n.id)) continue;
    if (ui.drag && ui.drag.rip && ui.drag.active.id === n.id) continue;
    const tint = colorFill(effectiveColor(n)) ?? 'var(--edge)';
    // A straight line from the annotation's CENTRE to the CLOSEST point on the parent's bounds
    // (clamp the centre into the parent rect), with the anchor dot at that closest point.
    // The top edge is the BOX's, not the bounds': a frame's bounds include its folder tab, which is
    // a separate shape hanging above the box (elTop / FRAME_TAB_DROP), and half of that strip isn't
    // even drawn — so an annotation sitting above a frame would otherwise land its dot on the tab, or
    // in the empty gap beside it, instead of on the box it annotates. elTop is 0 for everything else,
    // a FOLDED frame and a docked tab included: there the tab is all there is, so it IS the body.
    const ax = n.x + nodeW(n)/2, ay = n.y + nodeH(n)/2;
    const bx = clamp(ax, parent.x, parent.x + nodeW(parent));
    const by = clamp(ay, elTop(parent, parent.y), parent.y + nodeH(parent));
    const els = `<path class="anno-edge" style="stroke:${tint}" stroke-dasharray="2 6" d="M ${ax} ${ay} L ${bx} ${by}"/>`
      + `<circle class="edge-dot" cx="${bx}" cy="${by}" r="${DOT_R}" fill="${tint}"/>`;
    if (inDragGroup(n.id)) dragged += els; else annos += els;
  }
  edgesSvg.innerHTML = '';
  dragEdgesSvg.innerHTML = annos;
  dragLayerEdges.innerHTML = dragged;
}

// A node's branch tint — the same --card fill the card itself wears. Kept for the drag previews
// that still colour a ghost to match the card it came from.
export function branchTint(n: MindNode): string { return colorFill(effectiveColor(n)) ?? '#888'; }
