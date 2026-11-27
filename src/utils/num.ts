export function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }


// The GRID's snap, applied CONTINUOUSLY (never eased: any pull lags the pointer). A step ≤ 1 is no snap.
export function snapTo(v: number, step: number): number {
  return step <= 1 ? v : Math.round(v / step) * step;
}
