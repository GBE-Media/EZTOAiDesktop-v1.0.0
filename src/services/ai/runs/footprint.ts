/**
 * Building footprint: the cells of a plan view that are inside the building, found from the
 * drawn walls. Runs, risers and drawn arcs stay inside it, so nothing is routed through the
 * white space around (or between) floor plans.
 *
 *  1. Rasterise the line work of each view (grid lines — long lines ending at a grid bubble —
 *     are left out: they cross the white space).
 *  2. Close door gaps by dilating the walls a few cells.
 *  3. Flood the white space from the view's edge band; everything the flood can't reach is
 *     inside the building. Small enclosed pockets (dimension strings, keynote boxes out in the
 *     margin) are dropped by keeping only the large inside regions.
 * If the outline can't be closed (scanned sheet, open site plan) the view has no mask and
 * routing falls back to the view box.
 */
import type { Box, Pt } from './spatial';
import type { AnnotationBubble } from '../detection/annotationBubbles';

export interface Footprint {
  cell: number;
  gw: number;
  gh: number;
  /** 1 = inside the building. */
  inside: Uint8Array;
  /** Views whose outline closed (others are unmasked). */
  maskedViews: Box[];
}

export function routerGrid(W: number, H: number): { cell: number; gw: number; gh: number } {
  const cell = Math.max(W, H) / 320;
  return { cell, gw: Math.ceil(W / cell), gh: Math.ceil(H / cell) };
}

function rasterize(segments: ArrayLike<number>, box: Box, cell: number, gw: number, gh: number, skip: (i: number) => boolean): Uint8Array {
  const out = new Uint8Array(gw * gh);
  const n = Math.floor(segments.length / 4);
  const bx1 = box.x; const by1 = box.y; const bx2 = box.x + box.width; const by2 = box.y + box.height;
  for (let i = 0; i < n; i += 1) {
    const x1 = segments[i * 4]; const y1 = segments[i * 4 + 1]; const x2 = segments[i * 4 + 2]; const y2 = segments[i * 4 + 3];
    if (Math.max(x1, x2) < bx1 || Math.min(x1, x2) > bx2 || Math.max(y1, y2) < by1 || Math.min(y1, y2) > by2) continue;
    if (skip(i)) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (cell * 0.5)));
    for (let s = 0; s <= steps; s += 1) {
      const x = x1 + ((x2 - x1) * s) / steps;
      const y = y1 + ((y2 - y1) * s) / steps;
      const cx = Math.floor(x / cell); const cy = Math.floor(y / cell);
      if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) out[cy * gw + cx] = 1;
    }
  }
  return out;
}

function dilate(src: Uint8Array, gw: number, gh: number, r: number, x1: number, y1: number, x2: number, y2: number): Uint8Array {
  if (r <= 0) return src.slice();
  // Separable square dilation (horizontal then vertical) inside the view's cell range.
  const tmp = new Uint8Array(src.length);
  for (let y = y1; y <= y2; y += 1) {
    let last = -Infinity;
    for (let x = x1; x <= x2; x += 1) if (src[y * gw + x]) last = x; else if (x - last <= r) tmp[y * gw + x] = 1;
    last = Infinity;
    for (let x = x2; x >= x1; x -= 1) { if (src[y * gw + x]) { last = x; tmp[y * gw + x] = 1; } else if (last - x <= r) tmp[y * gw + x] = 1; }
  }
  const out = new Uint8Array(src.length);
  for (let x = x1; x <= x2; x += 1) {
    let last = -Infinity;
    for (let y = y1; y <= y2; y += 1) if (tmp[y * gw + x]) { last = y; out[y * gw + x] = 1; } else if (y - last <= r) out[y * gw + x] = 1;
    last = Infinity;
    for (let y = y2; y >= y1; y -= 1) if (tmp[y * gw + x]) last = y; else if (last - y <= r) out[y * gw + x] = 1;
  }
  return out;
}

function erode(src: Uint8Array, gw: number, gh: number, r: number, x1: number, y1: number, x2: number, y2: number): Uint8Array {
  const inv = new Uint8Array(src.length);
  for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) inv[y * gw + x] = src[y * gw + x] ? 0 : 1;
  const grown = dilate(inv, gw, gh, r, x1, y1, x2, y2);
  const out = new Uint8Array(src.length);
  for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) {
    const c = y * gw + x;
    // Cells on the view border erode too (the flood band already treats them as outside).
    if (!grown[c] && x - x1 >= r && x2 - x >= r && y - y1 >= r && y2 - y >= r) out[c] = 1;
  }
  return out;
}

/**
 * Inside-the-building mask for one view, or null when the outline doesn't close.
 * Exported for tests.
 */
export function viewFootprint(
  segments: ArrayLike<number>,
  box: Box,
  grid: { cell: number; gw: number; gh: number },
  skip: (i: number) => boolean = () => false,
): Uint8Array | null {
  const { cell, gw, gh } = grid;
  const x1 = Math.max(0, Math.floor(box.x / cell));
  const y1 = Math.max(0, Math.floor(box.y / cell));
  const x2 = Math.min(gw - 1, Math.floor((box.x + box.width) / cell));
  const y2 = Math.min(gh - 1, Math.floor((box.y + box.height) / cell));
  const bw = x2 - x1 + 1; const bh = y2 - y1 + 1;
  if (bw < 12 || bh < 12) return null;
  const walls = rasterize(segments, box, cell, gw, gh, skip);
  const area = bw * bh;
  // Door / storefront gaps: try a small closing first, wider ones if the flood leaks in.
  for (const r of [2, 3, 5]) {
    const closed = dilate(walls, gw, gh, r, x1, y1, x2, y2);
    const outside = new Uint8Array(gw * gh);
    const queue: number[] = [];
    const band = Math.max(2, Math.round(Math.min(bw, bh) * 0.03));
    for (let y = y1; y <= y2; y += 1) {
      for (let x = x1; x <= x2; x += 1) {
        if (x - x1 >= band && x2 - x >= band && y - y1 >= band && y2 - y >= band) continue;
        const c = y * gw + x;
        if (!closed[c] && !outside[c]) { outside[c] = 1; queue.push(c); }
      }
    }
    for (let q = 0; q < queue.length; q += 1) {
      const c = queue[q];
      const x = c % gw; const y = (c - x) / gw;
      if (x > x1) { const n = c - 1; if (!closed[n] && !outside[n]) { outside[n] = 1; queue.push(n); } }
      if (x < x2) { const n = c + 1; if (!closed[n] && !outside[n]) { outside[n] = 1; queue.push(n); } }
      if (y > y1) { const n = c - gw; if (!closed[n] && !outside[n]) { outside[n] = 1; queue.push(n); } }
      if (y < y2) { const n = c + gw; if (!closed[n] && !outside[n]) { outside[n] = 1; queue.push(n); } }
    }
    // Give back the padding the closing added on the outside of the exterior walls, so the
    // mask hugs the drawn outline instead of spilling past it.
    const nearOutside = dilate(outside, gw, gh, r, x1, y1, x2, y2);
    const inside = new Uint8Array(gw * gh);
    for (let y = y1; y <= y2; y += 1) {
      for (let x = x1; x <= x2; x += 1) {
        const c = y * gw + x;
        if (outside[c]) continue;
        if (nearOutside[c] && !walls[c]) continue;
        inside[c] = 1;
      }
    }
    // Opening (erode then grow back): strips bands up to four cells wide left by lone lines
    // (grid lines, dimension strings) out in the white space; rooms are far wider.
    const opened = dilate(erode(inside, gw, gh, 2, x1, y1, x2, y2), gw, gh, 2, x1, y1, x2, y2);
    for (let i = 0; i < opened.length; i += 1) if (!inside[i]) opened[i] = 0;
    const kept = keepLargeRegions(opened, gw, x1, y1, x2, y2);
    const share = kept.count / area;
    // A closed outline holds a real share of the view; a leak leaves only wall slivers.
    if (share >= 0.05 && share <= 0.97) return kept.mask;
  }
  return null;
}

function keepLargeRegions(mask: Uint8Array, gw: number, x1: number, y1: number, x2: number, y2: number): { mask: Uint8Array; count: number } {
  const label = new Int32Array(mask.length).fill(-1);
  const sizes: number[] = [];
  for (let y = y1; y <= y2; y += 1) {
    for (let x = x1; x <= x2; x += 1) {
      const start = y * gw + x;
      if (!mask[start] || label[start] >= 0) continue;
      const id = sizes.length;
      let size = 0;
      const stack = [start];
      label[start] = id;
      while (stack.length) {
        const c = stack.pop() as number;
        size += 1;
        const cx = c % gw; const cy = (c - cx) / gw;
        const ns = [cx > x1 ? c - 1 : -1, cx < x2 ? c + 1 : -1, cy > y1 ? c - gw : -1, cy < y2 ? c + gw : -1];
        for (const n of ns) if (n >= 0 && mask[n] && label[n] < 0) { label[n] = id; stack.push(n); }
      }
      sizes.push(size);
    }
  }
  if (!sizes.length) return { mask, count: 0 };
  const biggest = Math.max(...sizes);
  const out = new Uint8Array(mask.length);
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (label[i] >= 0 && sizes[label[i]] >= biggest * 0.15) { out[i] = 1; count += 1; }
  }
  return { mask: out, count };
}

/**
 * Footprint over every view. Grid lines (long lines with an end on a grid bubble) are skipped.
 */
export function buildFootprint(
  segments: ArrayLike<number> | undefined,
  W: number,
  H: number,
  views: Box[],
  bubbles: AnnotationBubble[] = [],
  /** Non-plan areas inside the views (schedules, notes, title block) — never inside. */
  exclude: Box[] = [],
  /** Fixtures / panels: when given, only outline regions holding one of them are kept, so
   *  closed boxes out in the margins (notes, stamps, grid-line pockets) never count as inside. */
  anchors: Pt[] = [],
): Footprint | null {
  if (!segments || segments.length < 400 || !views.length) return null;
  const grid = routerGrid(W, H);
  const gridBubbles = bubbles.filter(b => b.kind === 'grid');
  const onBubble = (x: number, y: number) => gridBubbles.some(b => Math.hypot(b.cx - x, b.cy - y) <= b.r * 1.6);
  // Endpoint index: a diagonal with a loose end is a leader / keynote arrow, not a wall (angled
  // walls meet other walls at both ends). Leaders would otherwise pinch white space into the
  // building where they leave it.
  const n = Math.floor(segments.length / 4);
  const ends = new Map<string, number>();
  const key = (x: number, y: number) => `${Math.round(x / 2)}:${Math.round(y / 2)}`;
  for (let i = 0; i < n; i += 1) {
    for (const k of [key(segments[i * 4], segments[i * 4 + 1]), key(segments[i * 4 + 2], segments[i * 4 + 3])]) ends.set(k, (ends.get(k) || 0) + 1);
  }
  const joined = (x: number, y: number) => {
    const bx = Math.round(x / 2); const by = Math.round(y / 2);
    let count = 0;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) count += ends.get(`${bx + dx}:${by + dy}`) || 0;
    return count > 1; // more than the segment's own end
  };
  const skip = (i: number) => {
    const x1 = segments[i * 4]; const y1 = segments[i * 4 + 1]; const x2 = segments[i * 4 + 2]; const y2 = segments[i * 4 + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const dx = Math.abs(x2 - x1); const dy = Math.abs(y2 - y1);
    const diagonal = Math.min(dx, dy) > Math.max(dx, dy) * 0.14;
    if (diagonal && len > 12 && !(joined(x1, y1) && joined(x2, y2))) return true;
    if (!gridBubbles.length) return false;
    return len > (gridBubbles[0].r * 4) && (onBubble(x1, y1) || onBubble(x2, y2));
  };
  const inside = new Uint8Array(grid.gw * grid.gh);
  const maskedViews: Box[] = [];
  for (const view of views) {
    const mask = viewFootprint(segments, view, grid, skip);
    if (!mask) continue;
    maskedViews.push(view);
    for (let i = 0; i < mask.length; i += 1) if (mask[i]) inside[i] = 1;
  }
  if (!maskedViews.length) return null;
  for (const b of exclude) {
    const ex1 = Math.max(0, Math.floor(b.x / grid.cell)); const ey1 = Math.max(0, Math.floor(b.y / grid.cell));
    const ex2 = Math.min(grid.gw - 1, Math.floor((b.x + b.width) / grid.cell)); const ey2 = Math.min(grid.gh - 1, Math.floor((b.y + b.height) / grid.cell));
    for (let y = ey1; y <= ey2; y += 1) for (let x = ex1; x <= ex2; x += 1) inside[y * grid.gw + x] = 0;
  }
  if (anchors.length) keepAnchoredRegions(inside, grid.gw, grid.gh, grid.cell, anchors);
  return { ...grid, inside, maskedViews };
}

function keepAnchoredRegions(inside: Uint8Array, gw: number, gh: number, cell: number, anchors: Pt[]): void {
  const keep = new Uint8Array(inside.length);
  const stack: number[] = [];
  const seed = (c: number) => { if (inside[c] && !keep[c]) { keep[c] = 1; stack.push(c); } };
  for (const a of anchors) {
    const ax = Math.floor(a.x / cell); const ay = Math.floor(a.y / cell);
    // A fixture drawn on (or just outside) an exterior wall still anchors the building.
    for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
      const x = ax + dx; const y = ay + dy;
      if (x >= 0 && y >= 0 && x < gw && y < gh) seed(y * gw + x);
    }
  }
  if (!stack.length) return;
  while (stack.length) {
    const c = stack.pop() as number;
    const x = c % gw; const y = (c - x) / gw;
    if (x > 0) seed(c - 1);
    if (x < gw - 1) seed(c + 1);
    if (y > 0) seed(c - gw);
    if (y < gh - 1) seed(c + gw);
  }
  inside.set(keep);
}

const inBox = (p: Pt, b: Box) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

/** True when the point is inside the building (or in a view without a mask). */
export function footprintContains(fp: Footprint | null | undefined, p: Pt): boolean {
  if (!fp) return true;
  // Views whose outline didn't close are left to the plan-view box.
  if (!fp.maskedViews.some(v => inBox(p, v))) return true;
  const cx = Math.floor(p.x / fp.cell); const cy = Math.floor(p.y / fp.cell);
  if (cx < 0 || cy < 0 || cx >= fp.gw || cy >= fp.gh) return false;
  return fp.inside[cy * fp.gw + cx] === 1;
}

/** Nearest point inside the building (the point itself when already inside). */
export function snapInside(fp: Footprint | null | undefined, p: Pt): Pt {
  if (!fp || footprintContains(fp, p)) return p;
  const cx = Math.floor(p.x / fp.cell); const cy = Math.floor(p.y / fp.cell);
  for (let r = 1; r < 200; r += 1) {
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = cx + dx; const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= fp.gw || ny >= fp.gh || !fp.inside[ny * fp.gw + nx]) continue;
        const q = { x: (nx + 0.5) * fp.cell, y: (ny + 0.5) * fp.cell };
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    if (best) return best;
  }
  return p;
}

/** Share of a polyline's length that runs outside the building (0–1). */
export function outsideShare(fp: Footprint | null | undefined, path: Pt[]): number {
  if (!fp || path.length < 2) return 0;
  let total = 0;
  let out = 0;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]; const b = path[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / fp.cell));
    for (let s = 0; s < steps; s += 1) {
      const t = (s + 0.5) / steps;
      total += len / steps;
      if (!footprintContains(fp, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) out += len / steps;
    }
  }
  return total > 0 ? out / total : 0;
}
