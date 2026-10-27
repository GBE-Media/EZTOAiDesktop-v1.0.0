/**
 * Spatial model of a plan sheet for routing: obstacles (elevators, shafts, stairs, open-to-below),
 * walls (from vector segments) and an orthogonal A* router that goes around obstacles and
 * prefers fewer wall penetrations and fewer bends.
 *
 * All coordinates here are DISPLAY POINTS (pdf.js viewport at scale 1, /Rotate applied).
 */
import type { ZonePageInput } from '../detection/pageZones';
import type { Footprint } from './footprint';

export type Pt = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

export type Obstacle = {
  kind: 'elevator' | 'shaft' | 'stair' | 'opening' | 'equipment';
  label: string;
  box: Box;
  /** Room outline not found — box is an estimate around the label. */
  approximate?: boolean;
  /** Already on the page as a locked keep-clear markup (not drawn again). */
  placed?: boolean;
  /** Drawn by the user. */
  userZone?: boolean;
};

const OBSTACLE_PATTERNS: Array<{ kind: Obstacle['kind']; re: RegExp }> = [
  { kind: 'elevator', re: /\b(ELEV(ATOR)?|ELEV\.?\s*\d*|LIFT)\b/i },
  { kind: 'shaft', re: /\b(SHAFT|CHASE)\b/i },
  { kind: 'stair', re: /\b(STAIRS?|STAIRWELL|STAIR\s*\d+)\b/i },
  { kind: 'opening', re: /\b(OPEN\s+TO\s+BELOW|OPEN\s+BELOW|ATRIUM|SKYLIGHT)\b/i },
];

/** "T.O. ELEV 112'-0\"", "ELEV. +10'", "FF ELEV" — a height callout, not an elevator. */
export function isElevationMark(text: string): boolean {
  return /\d\s*['′]|[+-]\s*\d|\b(T\.?\s?O\.?|B\.?\s?O\.?|F\.?\s?F\.?|FIN(ISH)?\.?\s*FLR|TOP\s+OF)\b/i.test(text);
}

/** Grid raster of wall/vector segments. */
export class SegmentRaster {
  readonly cell: number;
  readonly gw: number;
  readonly gh: number;
  readonly data: Uint8Array;

  constructor(readonly width: number, readonly height: number, cell: number) {
    this.cell = cell;
    this.gw = Math.max(1, Math.ceil(width / cell));
    this.gh = Math.max(1, Math.ceil(height / cell));
    this.data = new Uint8Array(this.gw * this.gh);
  }

  index(x: number, y: number): number {
    const cx = Math.min(this.gw - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.gh - 1, Math.max(0, Math.floor(y / this.cell)));
    return cy * this.gw + cx;
  }

  drawSegments(segments: ArrayLike<number>, maxLen: number): void {
    for (let i = 0; i + 3 < segments.length; i += 4) {
      const x1 = segments[i]; const y1 = segments[i + 1]; const x2 = segments[i + 2]; const y2 = segments[i + 3];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len > maxLen) continue; // sheet borders, title-block frames
      const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
      for (let s = 0; s <= steps; s += 1) {
        this.data[this.index(x1 + ((x2 - x1) * s) / steps, y1 + ((y2 - y1) * s) / steps)] = 1;
      }
    }
  }

  dilate(radius: number): Uint8Array {
    if (radius <= 0) return this.data.slice();
    const out = new Uint8Array(this.data.length);
    for (let cy = 0; cy < this.gh; cy += 1) {
      for (let cx = 0; cx < this.gw; cx += 1) {
        if (!this.data[cy * this.gw + cx]) continue;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const ny = cy + dy;
          if (ny < 0 || ny >= this.gh) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const nx = cx + dx;
            if (nx >= 0 && nx < this.gw) out[ny * this.gw + nx] = 1;
          }
        }
      }
    }
    return out;
  }
}

/**
 * Find obstacle rooms from their labels: flood-fill the enclosed room around the label on a
 * wall raster (walls dilated to close door openings). Falls back to a box around the label.
 */
export function detectObstacles(input: ZonePageInput, within?: Box[], excluded?: Box[]): Obstacle[] {
  const W = input.pageWidth;
  const H = input.pageHeight;
  const cell = Math.max(W, H) / 700;
  const raster = new SegmentRaster(W, H, cell);
  raster.drawSegments(input.segments || [], Math.max(W, H) * 0.3);
  const walls = raster.dilate(3);
  const maxCells = Math.floor((W * H * 0.02) / (cell * cell));
  const out: Obstacle[] = [];
  for (const item of input.textItems) {
    const text = item.str.trim();
    if (text.length > 30) continue; // labels, not notes
    const hit = OBSTACLE_PATTERNS.find(p => p.re.test(text));
    if (!hit) continue;
    // Elevation marks ("T.O. ELEV 112'-0\"", "ELEV +10'") aren't elevators.
    if (hit.kind === 'elevator' && isElevationMark(text)) continue;
    const center = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
    if (within?.length && !within.some(box => pointIn(center, box))) continue;
    if (excluded?.some(box => pointIn(center, box))) continue;
    if (out.some(o => pointIn(center, o.box))) continue;
    let room = floodRoom(walls, raster, center, maxCells);
    // A "room" much bigger than a stair / elevator core leaked through an opening: don't trust it.
    const maxSide = Math.max(W, H) * 0.08;
    if (room && (room.width > maxSide || room.height > maxSide)) room = null;
    const fh = item.fontHeight || item.height || 8;
    // No closed room around the label: a modest draft box on the label (the user confirms it).
    const fallbackSize = Math.max(item.width * 1.6, fh * 8);
    const box = room || {
      x: center.x - fallbackSize / 2,
      y: center.y - fallbackSize / 2,
      width: fallbackSize,
      height: fallbackSize,
    };
    out.push({ kind: hit.kind, label: text, box, ...(room ? {} : { approximate: true }) });
  }
  return out;
}

function floodRoom(walls: Uint8Array, raster: SegmentRaster, start: Pt, maxCells: number): Box | null {
  const { gw, gh } = raster;
  const s = raster.index(start.x, start.y);
  // Labels sit on top of their own glyph strokes; search a small neighbourhood for open floor.
  let seed = -1;
  const sx = s % gw; const sy = (s - sx) / gw;
  for (let r = 0; r <= 4 && seed < 0; r += 1) {
    for (let dy = -r; dy <= r && seed < 0; dy += 1) {
      for (let dx = -r; dx <= r && seed < 0; dx += 1) {
        const nx = sx + dx; const ny = sy + dy;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && !walls[ny * gw + nx]) seed = ny * gw + nx;
      }
    }
  }
  if (seed < 0) return null;
  const seen = new Uint8Array(walls.length);
  const queue = [seed];
  seen[seed] = 1;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  let count = 0;
  while (queue.length) {
    const c = queue.pop() as number;
    count += 1;
    if (count > maxCells) return null; // leaked out of the room
    const cx = c % gw; const cy = (c - cx) / gw;
    x1 = Math.min(x1, cx); x2 = Math.max(x2, cx); y1 = Math.min(y1, cy); y2 = Math.max(y2, cy);
    const neighbours = [c - 1, c + 1, c - gw, c + gw];
    for (let k = 0; k < 4; k += 1) {
      const n = neighbours[k];
      if (n < 0 || n >= walls.length) continue;
      if (k === 0 && cx === 0) continue;
      if (k === 1 && cx === gw - 1) continue;
      if (walls[n] || seen[n]) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
  if (count < 6) return null;
  // Include the (dilated) walls around the room.
  const pad = 3;
  return {
    x: (x1 - pad) * raster.cell,
    y: (y1 - pad) * raster.cell,
    width: (x2 - x1 + 1 + 2 * pad) * raster.cell,
    height: (y2 - y1 + 1 + 2 * pad) * raster.cell,
  };
}

export type RouterOptions = {
  width: number;
  height: number;
  segments?: ArrayLike<number>;
  obstacles: Box[];
  /** Routing is limited to these areas (plan views); empty = whole sheet. */
  allowed?: Box[];
  /** Non-plan areas (schedules, notes, title block) are never crossed. */
  blocked?: Box[];
  /** Clearance around obstacles, points. */
  clearance?: number;
  /** Building footprint: inside its masked views, cells outside the building are blocked. */
  footprint?: Footprint | null;
};

/** Orthogonal A* router with bend and wall-penetration penalties. */
export class OrthoRouter {
  readonly cell: number;
  readonly gw: number;
  readonly gh: number;
  private readonly blocked: Uint8Array;
  private readonly wall: Uint8Array;
  private readonly used: Uint16Array;

  constructor(private readonly options: RouterOptions) {
    const { width: W, height: H } = options;
    this.cell = Math.max(W, H) / 320;
    this.gw = Math.ceil(W / this.cell);
    this.gh = Math.ceil(H / this.cell);
    this.blocked = new Uint8Array(this.gw * this.gh);
    this.used = new Uint16Array(this.gw * this.gh);
    const raster = new SegmentRaster(W, H, this.cell);
    raster.drawSegments(options.segments || [], Math.max(W, H) * 0.3);
    this.wall = raster.data;
    if (options.allowed?.length) {
      this.blocked.fill(1);
      for (const box of options.allowed) this.fill(box, 0);
    }
    for (const box of options.blocked || []) this.fill(box, 1);
    const fp = options.footprint;
    if (fp && fp.gw === this.gw && fp.gh === this.gh) {
      // White space around and between the buildings is never routed through.
      for (const view of fp.maskedViews) {
        const x1 = Math.max(0, Math.floor(view.x / this.cell));
        const y1 = Math.max(0, Math.floor(view.y / this.cell));
        const x2 = Math.min(this.gw - 1, Math.floor((view.x + view.width) / this.cell));
        const y2 = Math.min(this.gh - 1, Math.floor((view.y + view.height) / this.cell));
        for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) if (!fp.inside[y * this.gw + x]) this.blocked[y * this.gw + x] = 1;
      }
    }
    const clearance = options.clearance ?? this.cell;
    for (const box of options.obstacles) {
      this.fill({ x: box.x - clearance, y: box.y - clearance, width: box.width + 2 * clearance, height: box.height + 2 * clearance }, 1);
    }
  }

  private fill(box: Box, value: number): void {
    const x1 = Math.max(0, Math.floor(box.x / this.cell));
    const y1 = Math.max(0, Math.floor(box.y / this.cell));
    const x2 = Math.min(this.gw - 1, Math.floor((box.x + box.width) / this.cell));
    const y2 = Math.min(this.gh - 1, Math.floor((box.y + box.height) / this.cell));
    for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) this.blocked[y * this.gw + x] = value;
  }

  private nearestFree(p: Pt): number {
    const cx = Math.min(this.gw - 1, Math.max(0, Math.floor(p.x / this.cell)));
    const cy = Math.min(this.gh - 1, Math.max(0, Math.floor(p.y / this.cell)));
    for (let r = 0; r < 40; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx; const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
          if (!this.blocked[ny * this.gw + nx]) return ny * this.gw + nx;
        }
      }
    }
    return cy * this.gw + cx;
  }

  /** Mark a routed path so later conduits run alongside (not on top of) it. */
  markUsed(path: Pt[]): void {
    for (let i = 0; i + 1 < path.length; i += 1) {
      const a = path[i]; const b = path[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (this.cell * 0.5)));
      for (let s = 0; s <= steps; s += 1) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const y = a.y + ((b.y - a.y) * s) / steps;
        const cx = Math.floor(x / this.cell); const cy = Math.floor(y / this.cell);
        if (cx >= 0 && cy >= 0 && cx < this.gw && cy < this.gh) this.used[cy * this.gw + cx] += 1;
      }
    }
  }

  route(from: Pt, to: Pt): { path: Pt[]; bends: number; wallCrossings: number; ok: boolean } {
    const start = this.nearestFree(from);
    const goal = this.nearestFree(to);
    const n = this.gw * this.gh;
    // State = cell * 4 + direction (0 E, 1 W, 2 S, 3 N).
    const g = new Float32Array(n * 4).fill(Infinity);
    const prev = new Int32Array(n * 4).fill(-1);
    const heap = new MinHeap();
    const gx = goal % this.gw; const gy = (goal - gx) / this.gw;
    const h = (c: number) => {
      const x = c % this.gw; const y = (c - x) / this.gw;
      return Math.abs(x - gx) + Math.abs(y - gy);
    };
    for (let d = 0; d < 4; d += 1) {
      g[start * 4 + d] = 0;
      heap.push(start * 4 + d, h(start));
    }
    const DX = [1, -1, 0, 0];
    const DY = [0, 0, 1, -1];
    const BEND = 6;
    const WALL = 10;
    const NEAR_USED = 0.4;
    const ON_USED = 3;
    let found = -1;
    let expanded = 0;
    while (heap.size) {
      const state = heap.pop();
      const c = state >> 2; const d = state & 3;
      if (c === goal) { found = state; break; }
      if (++expanded > 400_000) break;
      const cx = c % this.gw; const cy = (c - cx) / this.gw;
      const base = g[state];
      for (let nd = 0; nd < 4; nd += 1) {
        if ((d ^ nd) === 1 && (d >> 1) === (nd >> 1)) continue; // no U-turns
        const nx = cx + DX[nd]; const ny = cy + DY[nd];
        if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
        const nc = ny * this.gw + nx;
        if (this.blocked[nc] && nc !== goal) continue;
        let cost = 1;
        if (nd !== d && base > 0) cost += BEND;
        if (this.wall[nc] && !this.wall[c]) cost += WALL;
        if (this.used[nc]) cost += ON_USED;
        else if (this.usedNear(nx, ny)) cost -= NEAR_USED; // run parallel to existing conduits
        const ns = nc * 4 + nd;
        const next = base + cost;
        if (next < g[ns]) {
          g[ns] = next;
          prev[ns] = state;
          heap.push(ns, next + h(nc));
        }
      }
    }
    if (found < 0) {
      // No clear path: of the two L-shapes, take the one through the fewest blocked cells
      // (keep-clear zones / off-plan white space), never a blind diagonal.
      const a = [from, { x: to.x, y: from.y }, to];
      const b = [from, { x: from.x, y: to.y }, to];
      const path = this.blockedAlong(b) < this.blockedAlong(a) ? b : a;
      return { path, bends: 1, wallCrossings: 0, ok: false };
    }
    const cells: number[] = [];
    for (let s = found; s >= 0; s = prev[s]) cells.push(s >> 2);
    cells.reverse();
    let wallCrossings = 0;
    for (let i = 1; i < cells.length; i += 1) if (this.wall[cells[i]] && !this.wall[cells[i - 1]]) wallCrossings += 1;
    const pts = cells.map(c => {
      const x = c % this.gw; const y = (c - x) / this.gw;
      return { x: (x + 0.5) * this.cell, y: (y + 0.5) * this.cell };
    });
    const path = simplifyOrthogonal([from, ...snapEnds(pts, from, to), to]);
    return { path, bends: Math.max(0, path.length - 2), wallCrossings, ok: true };
  }

  /** Blocked cells a path passes through. */
  blockedAlong(path: Pt[]): number {
    let n = 0;
    for (let i = 0; i + 1 < path.length; i += 1) {
      const a = path[i]; const b = path[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (this.cell * 0.5)));
      for (let s = 0; s <= steps; s += 1) {
        const cx = Math.floor((a.x + ((b.x - a.x) * s) / steps) / this.cell);
        const cy = Math.floor((a.y + ((b.y - a.y) * s) / steps) / this.cell);
        if (cx >= 0 && cy >= 0 && cx < this.gw && cy < this.gh && this.blocked[cy * this.gw + cx]) n += 1;
      }
    }
    return n;
  }

  private usedNear(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < this.gw && ny < this.gh && this.used[ny * this.gw + nx]) return true;
      }
    }
    return false;
  }
}

/** Make the first/last legs orthogonal from the exact endpoints. */
function snapEnds(pts: Pt[], from: Pt, to: Pt): Pt[] {
  if (pts.length < 2) return pts;
  const out = pts.slice();
  const a = out[0]; const b = out[1];
  if (Math.abs(a.x - b.x) < 1e-6) out[0] = { x: a.x, y: from.y };
  else out[0] = { x: from.x, y: a.y };
  const z = out[out.length - 1]; const y = out[out.length - 2];
  if (Math.abs(z.x - y.x) < 1e-6) out[out.length - 1] = { x: z.x, y: to.y };
  else out[out.length - 1] = { x: to.x, y: z.y };
  return out;
}

/** Drop collinear points; keep the path axis-aligned. */
export function simplifyOrthogonal(path: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const collinear = (Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6)
        || (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6);
      if (!collinear) break;
      out.splice(out.length - 2, 1);
    }
  }
  return out;
}

export function pathLength(path: Pt[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i += 1) total += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
  return total;
}

/** Sum of bend angles (degrees) along a polyline. */
export function totalBendDegrees(path: Pt[]): number {
  let total = 0;
  for (let i = 1; i + 1 < path.length; i += 1) {
    const a = Math.atan2(path[i].y - path[i - 1].y, path[i].x - path[i - 1].x);
    const b = Math.atan2(path[i + 1].y - path[i].y, path[i + 1].x - path[i].x);
    let d = Math.abs(b - a) * (180 / Math.PI);
    if (d > 180) d = 360 - d;
    total += d;
  }
  return Math.round(total);
}

export function pointIn(p: Pt, box: Box): boolean {
  return p.x >= box.x && p.y >= box.y && p.x <= box.x + box.width && p.y <= box.y + box.height;
}

export function segmentHitsBox(a: Pt, b: Pt, box: Box): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
  for (let s = 0; s <= steps; s += 1) {
    if (pointIn({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps }, box)) return true;
  }
  return false;
}

class MinHeap {
  private keys: number[] = [];
  private prio: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, priority: number): void {
    const keys = this.keys; const prio = this.prio;
    keys.push(key); prio.push(priority);
    let i = keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (prio[p] <= prio[i]) break;
      [keys[p], keys[i]] = [keys[i], keys[p]];
      [prio[p], prio[i]] = [prio[i], prio[p]];
      i = p;
    }
  }
  pop(): number {
    const keys = this.keys; const prio = this.prio;
    const top = keys[0];
    const lastK = keys.pop() as number; const lastP = prio.pop() as number;
    if (keys.length) {
      keys[0] = lastK; prio[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; const r = l + 1;
        let m = i;
        if (l < keys.length && prio[l] < prio[m]) m = l;
        if (r < keys.length && prio[r] < prio[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]];
        [prio[m], prio[i]] = [prio[i], prio[m]];
        i = m;
      }
    }
    return top;
  }
}
