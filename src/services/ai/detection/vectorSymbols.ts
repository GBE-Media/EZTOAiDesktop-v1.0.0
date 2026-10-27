/**
 * Vector-symbol check for vision counts. CAD plans draw every fixture of a type as the same
 * block, so the PDF line work holds the exact position (and shape) of each symbol. After the
 * vision pass this:
 *  - snaps each detection onto the centre of the drawn symbol under/near it (pin-point markers);
 *  - drops a second detection of the same type that lands on a symbol already taken (a
 *    duplicate of one fixture, a common cause of drifting counts);
 *  - adds plan symbols drawn exactly like a type's confirmed fixtures that the vision pass
 *    missed (same every run, so counts stop moving between runs).
 * Nothing changes on sheets without usable line work (scanned plans, text-as-vector sheets).
 */
import type { DetectedItem } from '../providers/types';
import { zoneAtPoint, type PageZone } from './pageZones';

export interface SymbolComponent {
  cx: number;
  cy: number;
  w: number;
  h: number;
  n: number;
  /** Shape fingerprint (rotation-agnostic for 90° turns). */
  sig: string;
}

/** Segments longer than this (pt) are walls / grid / circuit lines, not symbol strokes. */
const MAX_STROKE_PT = 48;
/** Symbol size range (pt). */
const MIN_SYMBOL_PT = 3.5;
const MAX_SYMBOL_PT = 64;
/** Endpoints closer than this are joined (pt). */
const JOIN_PT = 0.9;
/** A detection snaps to a symbol whose centre is within this distance (pt, ~1/3"). */
const SNAP_PT = 24;
/** Fixtures added from a printed tag sit beside the tag, so they look further. */
const TAG_SNAP_PT = 54;
const MAX_COMPONENTS = 60_000;
/** "Sitting on" a symbol (pt). */
const CLOSE_PT = 9;

export function buildSymbolComponents(segments: ArrayLike<number> | undefined): SymbolComponent[] {
  if (!segments || segments.length < 12) return [];
  const count = Math.floor(segments.length / 4);
  const keep: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const x1 = segments[i * 4]; const y1 = segments[i * 4 + 1]; const x2 = segments[i * 4 + 2]; const y2 = segments[i * 4 + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len > 0 && len <= MAX_STROKE_PT) keep.push(i);
  }
  if (!keep.length) return [];
  const parent = keep.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };
  // Endpoints hashed on a JOIN_PT grid; neighbouring cells checked so near-misses still join.
  const grid = new Map<string, number[]>();
  const cell = (v: number) => Math.floor(v / JOIN_PT);
  keep.forEach((seg, k) => {
    for (const e of [0, 2]) {
      const x = segments[seg * 4 + e]; const y = segments[seg * 4 + e + 1];
      const cx = cell(x); const cy = cell(y);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const hit = grid.get(`${cx + dx}:${cy + dy}`);
          if (hit) for (const other of hit) union(k, other);
        }
      }
      const key = `${cx}:${cy}`;
      const list = grid.get(key);
      if (list) list.push(k); else grid.set(key, [k]);
    }
  });
  const groups = new Map<number, number[]>();
  keep.forEach((_, k) => {
    const r = find(k);
    const list = groups.get(r);
    if (list) list.push(k); else groups.set(r, [k]);
  });
  const out: SymbolComponent[] = [];
  for (const members of groups.values()) {
    if (members.length < 3) continue;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    const lens: number[] = [];
    for (const k of members) {
      const s = keep[k] * 4;
      const x1 = segments[s]; const y1 = segments[s + 1]; const x2 = segments[s + 2]; const y2 = segments[s + 3];
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
      lens.push(Math.round(Math.hypot(x2 - x1, y2 - y1) * 2) / 2);
    }
    const w = maxX - minX; const h = maxY - minY;
    const size = Math.max(w, h);
    if (size < MIN_SYMBOL_PT || size > MAX_SYMBOL_PT) continue;
    lens.sort((a, b) => a - b);
    const dims = [Math.round(w), Math.round(h)].sort((a, b) => a - b);
    out.push({ cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h, n: members.length, sig: `${dims[0]}x${dims[1]}|${members.length}|${lens.join(',')}` });
    if (out.length >= MAX_COMPONENTS) break;
  }
  return out;
}

export interface SymbolRefineResult {
  items: DetectedItem[];
  snapped: number;
  duplicates: number;
  added: number;
  /** Detections with a location that were checked. */
  checked?: number;
  /** Detections the model placed within 9 pt of their symbol (before snapping). */
  onSymbol?: number;
  /** How far (pt) each snapped detection was from the drawn symbol. */
  moves?: number[];
  /** Per type: how many detections share the type's drawn symbol. */
  shapeAgreement: Record<string, { matched: number; total: number }>;
}

const typeOf = (item: DetectedItem) => (item.legendTypeCode || item.type || '').trim().toUpperCase();
const unresolved = (code: string) => !code || code === 'NO_CONFIDENT_MATCH' || code === 'UNKNOWN';

export function refineDetectionsWithSymbols(
  items: DetectedItem[],
  components: SymbolComponent[],
  pageWidth: number,
  pageHeight: number,
  options: { zones?: PageZone[]; region?: { x: number; y: number; width: number; height: number } } = {},
): SymbolRefineResult {
  const empty: SymbolRefineResult = { items, snapped: 0, duplicates: 0, added: 0, shapeAgreement: {} };
  if (!components.length || !items.length || pageWidth <= 0 || pageHeight <= 0) return empty;

  // Spatial hash of symbol centres.
  const CELL = TAG_SNAP_PT;
  const buckets = new Map<string, number[]>();
  components.forEach((c, i) => {
    const key = `${Math.floor(c.cx / CELL)}:${Math.floor(c.cy / CELL)}`;
    const list = buckets.get(key);
    if (list) list.push(i); else buckets.set(key, [i]);
  });
  const near = (x: number, y: number, r: number) => {
    const out: Array<{ i: number; d: number }> = [];
    const cx = Math.floor(x / CELL); const cy = Math.floor(y / CELL);
    const reach = Math.ceil(r / CELL);
    for (let dx = -reach; dx <= reach; dx += 1) {
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (const i of buckets.get(`${cx + dx}:${cy + dy}`) || []) {
          const d = Math.hypot(components[i].cx - x, components[i].cy - y);
          if (d <= r) out.push({ i, d });
        }
      }
    }
    return out;
  };

  const pts = items.map(item => (item.locationMissing || !Number.isFinite(item.location?.x) || !Number.isFinite(item.location?.y)
    ? null
    : { x: (item.location.x / 100) * pageWidth, y: (item.location.y / 100) * pageHeight }));

  // Vote each type's drawn shape from detections sitting right on a symbol.
  const votes = new Map<string, Map<string, number>>();
  pts.forEach((p, idx) => {
    if (!p) return;
    const code = typeOf(items[idx]);
    if (unresolved(code)) return;
    const hit = near(p.x, p.y, CLOSE_PT).sort((a, b) => a.d - b.d)[0];
    if (!hit) return;
    const m = votes.get(code) || new Map<string, number>();
    m.set(components[hit.i].sig, (m.get(components[hit.i].sig) || 0) + 1);
    votes.set(code, m);
  });
  const voted = new Map<string, string>();
  for (const [code, sigs] of votes) {
    const all = [...sigs.values()].reduce((a, b) => a + b, 0);
    const [sig, n] = [...sigs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (n >= 3 && n >= all * 0.5) voted.set(code, sig);
  }

  // Closest (item, symbol) pairs first; one symbol per item. A type with a known shape only
  // snaps to that shape (never onto a door swing or a neighbouring device); others only snap
  // to a symbol they already sit on.
  const pairs: Array<{ item: number; comp: number; d: number }> = [];
  pts.forEach((p, idx) => {
    if (!p) return;
    const shape = voted.get(typeOf(items[idx]));
    const radius = shape ? (items[idx].id.startsWith('tag_') ? TAG_SNAP_PT : SNAP_PT) : CLOSE_PT;
    for (const hit of near(p.x, p.y, radius)) {
      if (shape && components[hit.i].sig !== shape) continue;
      pairs.push({ item: idx, comp: hit.i, d: hit.d });
    }
  });
  pairs.sort((a, b) => a.d - b.d || a.item - b.item || a.comp - b.comp);
  const itemComp = new Map<number, number>();
  const compItem = new Map<number, number>();
  const contested = new Map<number, number>();
  for (const pair of pairs) {
    if (itemComp.has(pair.item)) continue;
    const holder = compItem.get(pair.comp);
    if (holder !== undefined) {
      // Same type on a symbol that's already taken, right on top of it: one fixture seen twice.
      const sameType = typeOf(items[holder]) === typeOf(items[pair.item]) && !unresolved(typeOf(items[pair.item]));
      const c = components[pair.comp];
      if (sameType && pair.d <= Math.max(c.w, c.h) * 0.75 + 2 && !contested.has(pair.item)) contested.set(pair.item, holder);
      continue;
    }
    itemComp.set(pair.item, pair.comp);
    compItem.set(pair.comp, pair.item);
  }

  let snapped = 0;
  let duplicates = 0;
  let onSymbol = 0;
  const moves: number[] = [];
  const next: DetectedItem[] = [];
  items.forEach((item, idx) => {
    const comp = itemComp.get(idx);
    if (comp === undefined && contested.has(idx)) {
      duplicates += 1;
      return;
    }
    if (comp === undefined) { next.push(item); return; }
    const c = components[comp];
    const p = pts[idx]!;
    const off = Math.hypot(c.cx - p.x, c.cy - p.y);
    moves.push(Math.round(off * 10) / 10);
    if (off <= CLOSE_PT) onSymbol += 1;
    const x = Math.round((c.cx / pageWidth) * 100 * 1000) / 1000;
    const y = Math.round((c.cy / pageHeight) * 100 * 1000) / 1000;
    if (Math.abs(x - item.location.x) > 0.001 || Math.abs(y - item.location.y) > 0.001) snapped += 1;
    const boundingBox = {
      x: Math.round(((c.cx - c.w / 2) / pageWidth) * 100 * 1000) / 1000,
      y: Math.round(((c.cy - c.h / 2) / pageHeight) * 100 * 1000) / 1000,
      width: Math.round((c.w / pageWidth) * 100 * 1000) / 1000,
      height: Math.round((c.h / pageHeight) * 100 * 1000) / 1000,
    };
    next.push({ ...item, location: { ...item.location, x, y }, boundingBox, symbolSig: c.sig });
  });

  // Each type's drawn symbol = the shape most of its snapped detections share.
  const byType = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const item of next) {
    const code = typeOf(item);
    if (unresolved(code) || item.matchConfidence === 'low') continue;
    totals.set(code, (totals.get(code) || 0) + 1);
    const sig = item.symbolSig;
    if (!sig) continue;
    const m = byType.get(code) || new Map<string, number>();
    m.set(sig, (m.get(sig) || 0) + 1);
    byType.set(code, m);
  }
  const shapeAgreement: SymbolRefineResult['shapeAgreement'] = {};
  const dominant = new Map<string, string>();
  for (const [code, sigs] of byType) {
    const [sig, n] = [...sigs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const total = totals.get(code) || 0;
    shapeAgreement[code] = { matched: n, total };
    if (n >= 3 && n >= total * 0.6) dominant.set(code, sig);
  }
  // A shape used by two types (same block, told apart only by tag) can't type a new symbol.
  const sigOwners = new Map<string, string[]>();
  for (const [code, sig] of dominant) sigOwners.set(sig, [...(sigOwners.get(sig) || []), code]);

  const taken = new Set(compItem.keys());
  const additions: DetectedItem[] = [];
  const region = options.region;
  for (const [code, sig] of dominant) {
    if ((sigOwners.get(sig) || []).length > 1) continue;
    const template = next.find(item => typeOf(item) === code && item.symbolSig === sig)!;
    const found: DetectedItem[] = [];
    components.forEach((c, i) => {
      if (c.sig !== sig || taken.has(i)) return;
      if (region && (c.cx < region.x || c.cx > region.x + region.width || c.cy < region.y || c.cy > region.y + region.height)) return;
      const xPct = (c.cx / pageWidth) * 100;
      const yPct = (c.cy / pageHeight) * 100;
      const zone = options.zones?.length ? zoneAtPoint(options.zones, xPct, yPct) : null;
      if (options.zones?.length && (!zone || zone.kind !== 'plan')) return;
      // Something already counted right there (another type on the same spot).
      if (next.some(item => !item.locationMissing && Math.hypot((item.location.x / 100) * pageWidth - c.cx, (item.location.y / 100) * pageHeight - c.cy) < 6)) return;
      found.push({
        ...template,
        id: `sym_${code}_${i}`,
        location: { x: Math.round(xPct * 1000) / 1000, y: Math.round(yPct * 1000) / 1000 },
        boundingBox: {
          x: Math.round(((c.cx - c.w / 2) / pageWidth) * 100 * 1000) / 1000,
          y: Math.round(((c.cy - c.h / 2) / pageHeight) * 100 * 1000) / 1000,
          width: Math.round((c.w / pageWidth) * 100 * 1000) / 1000,
          height: Math.round((c.h / pageHeight) * 100 * 1000) / 1000,
        },
        confidence: 0.8,
        matchConfidence: 'medium',
        evidence: `Drawn exactly like the other ${shapeAgreement[code].matched} type ${code} fixtures on this plan; the vision pass missed it`,
        symbolSig: sig,
      });
    });
    // Too many look-alikes means the shape isn't specific to this fixture: add nothing.
    if (found.length && found.length <= Math.max(3, (totals.get(code) || 0) * 0.6)) additions.push(...found);
  }

  const checked = pts.filter(Boolean).length;
  return { items: [...next, ...additions], snapped, duplicates, added: additions.length, checked, onSymbol, moves, shapeAgreement };
}
