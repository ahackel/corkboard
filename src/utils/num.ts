// Confine `v` to [lo, hi]. Spelled out as a nested Math.max(lo, Math.min(hi, v)) at a dozen sites
// across the camera, the grid, the sketch smoother, the edge geometry and the stack's drop depth —
// which reads as arithmetic rather than as the intent, and gets its bounds swapped exactly often
// enough to be worth a name.
export function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

// The GRID's snap: the nearest multiple of `step`, and the ONE rule everything the pointer moves obeys
// — a dragged card, a resized box, a dragged junction dot. A step of 1 or less (grid off: the "No snap"
// size, see main.ts gridSnap) is no snap at all.
//
// It is applied CONTINUOUSLY, not eased and not deferred, so the thing being dragged is always sitting
// exactly on a grid position and jumps from one to the next as the pointer crosses the halfway line —
// which is what snapping means everywhere it exists, from PCB editors to level editors: "the object
// snaps to the closest grid vertex even though that vertex might be slightly outside the cursor path".
//
// A smooth pull toward the grid was tried instead (the value eased toward the nearest line, in
// proportion to how close it was) and it is the wrong idea however it is tuned: any pull is a GAP
// between the pointer and the thing you are dragging, closing that gap means overtaking the pointer,
// and the object stops being pinned to the cursor. Quantising keeps the offset a plain constant inside
// the current cell — it reads as "this is snapped", where the eased version read as sluggish.
export function snapTo(v: number, step: number): number {
  return step <= 1 ? v : Math.round(v / step) * step;
}
