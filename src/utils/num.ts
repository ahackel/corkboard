// Confine `v` to [lo, hi]. Spelled out as a nested Math.max(lo, Math.min(hi, v)) at a dozen sites
// across the camera, the grid, the sketch smoother, the edge geometry and the stack's drop depth —
// which reads as arithmetic rather than as the intent, and gets its bounds swapped exactly often
// enough to be worth a name.
export function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
