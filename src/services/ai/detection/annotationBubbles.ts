/**
 * Drawing annotations drawn as circles that are never fixtures: column/row grid bubbles
 * ("1", "9.8", "A"), section/detail callouts ("5 / E-6") and view-title bubbles ("2  SECOND
 * FLOOR ELECTRICAL PLAN"). Vision models often count a grid bubble as a round fixture; a
 * detection sitting on one is removed, and the bubble's shape can never be "recovered" as a
 * missed fixture.
 */
import type { SymbolComponent } from './vectorSymbols';

export interface AnnotationBubble {
  cx: number;
  cy: number;
  r: number;
  kind: 'grid' | 'callout' | 'title';
  label: string;
}

type Text = { str: string; x: number; y: number; width: number; height: number };

/** Column numbers ("1", "9.8") and row letters ("A", "B.4", "A1"); never device codes like "OS". */
const GRID_LABEL = /^(\d{1,3}(\.\d{1,2})?|[A-Z](\.\d{1,2})?|[A-Z]\d{1,2})$/;
const SHEET_REF = /^[A-Z]{1,3}[-.]?\d{1,3}(\.\d{1,2})?[A-Z]?$/;

/** Round, closed-looking symbol big enough to hold a label. */
function isRound(c: SymbolComponent): boolean {
  const size = Math.max(c.w, c.h);
  return size >= 9 && size <= 64 && Math.abs(c.w - c.h) <= 0.18 * size && c.n >= 4;
}

export function findAnnotationBubbles(components: SymbolComponent[], texts: Text[]): AnnotationBubble[] {
  const items = texts
    .map(t => ({ str: t.str.trim(), cx: t.x + t.width / 2, cy: t.y + t.height / 2, h: t.height, x: t.x, w: t.width }))
    .filter(t => t.str);
  // Coarse spatial index on text centres.
  const CELL = 40;
  const index = new Map<string, typeof items>();
  for (const t of items) {
    const key = `${Math.floor(t.cx / CELL)}:${Math.floor(t.cy / CELL)}`;
    const list = index.get(key);
    if (list) list.push(t); else index.set(key, [t]);
  }
  const near = (x: number, y: number, r: number) => {
    const out: typeof items = [];
    for (let gx = Math.floor((x - r) / CELL); gx <= Math.floor((x + r) / CELL); gx += 1) {
      for (let gy = Math.floor((y - r) / CELL); gy <= Math.floor((y + r) / CELL); gy += 1) {
        for (const t of index.get(`${gx}:${gy}`) || []) if (Math.hypot(t.cx - x, t.cy - y) <= r) out.push(t);
      }
    }
    return out;
  };

  const gridCandidates: AnnotationBubble[] = [];
  const out: AnnotationBubble[] = [];
  const seen = new Set<string>();
  for (const c of components) {
    if (!isRound(c)) continue;
    const key = `${Math.round(c.cx)}:${Math.round(c.cy)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = Math.max(c.w, c.h) / 2;
    const inside = near(c.cx, c.cy, r * 0.85);
    if (!inside.length) continue;
    const tokens = inside.flatMap(t => t.str.split(/\s+/)).filter(Boolean);
    const big = inside.some(t => t.h >= r * 0.45);
    // Callout: a number/letter over a sheet number ("5" / "E-6"), or "5/E-6".
    if (tokens.length >= 2 && tokens.some(s => SHEET_REF.test(s) && /\d/.test(s) && /[A-Z]/.test(s)) && tokens.some(s => /^[A-Z0-9]{1,3}$/.test(s))) {
      out.push({ cx: c.cx, cy: c.cy, r, kind: 'callout', label: tokens.join(' / ') });
      continue;
    }
    if (tokens.length === 1 && /^[A-Z0-9]{1,3}\/[A-Z]{1,3}[-.]?\d/.test(tokens[0])) {
      out.push({ cx: c.cx, cy: c.cy, r, kind: 'callout', label: tokens[0] });
      continue;
    }
    if (tokens.length !== 1 || !GRID_LABEL.test(tokens[0]) || !big) continue;
    // View title: "2" in a circle beside "... PLAN".
    const title = near(c.cx + r * 6, c.cy, r * 7).some(t => t.cx > c.cx + r && Math.abs(t.cy - c.cy) < r * 1.4 && /\bPLAN\b/i.test(t.str));
    if (title && /^\d{1,2}$/.test(tokens[0])) {
      out.push({ cx: c.cx, cy: c.cy, r, kind: 'title', label: tokens[0] });
      continue;
    }
    gridCandidates.push({ cx: c.cx, cy: c.cy, r, kind: 'grid', label: tokens[0] });
  }

  // Grid bubbles come in families: one size, a different label on each line, lined up along
  // the edge of the plan. Repeated labels (fixture-type tags, keynotes) or a lone "J" / "T" in a
  // circle (a device symbol) never qualify.
  const bySize = [...gridCandidates].sort((a, b) => a.r - b.r);
  const used = new Set<AnnotationBubble>();
  for (const seed of bySize) {
    if (used.has(seed)) continue;
    const family = bySize.filter(b => !used.has(b) && Math.abs(b.r - seed.r) <= Math.max(0.5, seed.r * 0.05));
    family.forEach(b => used.add(b));
    if (family.length < 4 || seed.r < 7) continue;
    const freq = new Map<string, number>();
    family.forEach(b => freq.set(b.label, (freq.get(b.label) || 0) + 1));
    // Each grid line has a bubble at one or both ends (and once per view on stacked sheets).
    const maxRepeat = Math.max(...freq.values());
    if (freq.size < 3 || maxRepeat > Math.max(4, family.length * 0.25)) continue;
    const distinctLine = (pick: (b: AnnotationBubble) => number) => family.some(a => {
      const line = family.filter(b => Math.abs(pick(b) - pick(a)) <= 2);
      return new Set(line.map(b => b.label)).size >= 3;
    });
    if (!(distinctLine(b => b.cy) || distinctLine(b => b.cx))) continue;
    out.push(...family);
    // Bubbles whose circle merged with its grid line still print their label on the same line.
    const r = seed.r;
    for (const t of items) {
      if (!GRID_LABEL.test(t.str) || t.h < r * 0.45 || t.h > r * 1.6) continue;
      if (out.some(b => Math.hypot(b.cx - t.cx, b.cy - t.cy) < r * 0.6)) continue;
      // Text boxes sit a little off the circle centre (baseline), so the line test is looser.
      const row = family.filter(b => Math.abs(b.cy - t.cy) <= r * 0.35);
      const col = family.filter(b => Math.abs(b.cx - t.cx) <= r * 0.35);
      if (row.length >= 2) out.push({ cx: t.cx, cy: row[0].cy, r, kind: 'grid', label: t.str });
      else if (col.length >= 2) out.push({ cx: col[0].cx, cy: t.cy, r, kind: 'grid', label: t.str });
    }
  }
  return out;
}

/** The bubble a point sits on (within its radius + a little), if any. */
export function bubbleAt(bubbles: AnnotationBubble[], x: number, y: number): AnnotationBubble | undefined {
  return bubbles.find(b => Math.hypot(b.cx - x, b.cy - y) <= b.r * 1.15);
}
