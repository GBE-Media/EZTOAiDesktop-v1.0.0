/**
 * Lining up stacked floor plans on one sheet. Views found from titles are rough (they include
 * the white space around a plan), so a riser mapped by relative position can land off the
 * drawing. Two fixes:
 *  - tightenToDrawing: shrink a view box to the line work actually drawn in it;
 *  - viewOffset: the column / row grid bubbles (1, 2, 9.8, D, E…) repeat on every floor, so the
 *    shift between two views is read from the same bubble on both.
 */
export type Box = { x: number; y: number; width: number; height: number };
type Pt = { x: number; y: number };
type Text = { str: string; x: number; y: number; width: number; height: number };

/** Shrink a box to where its line work is (ignoring stray long lines like the sheet border). */
export function tightenToDrawing(box: Box, segments: ArrayLike<number> | undefined): Box {
  if (!segments || segments.length < 4) return box;
  const xs: Array<[number, number]> = [];
  const ys: Array<[number, number]> = [];
  let total = 0;
  for (let i = 0; i + 3 < segments.length; i += 4) {
    const x1 = segments[i]; const y1 = segments[i + 1]; const x2 = segments[i + 2]; const y2 = segments[i + 3];
    const mx = (x1 + x2) / 2; const my = (y1 + y2) / 2;
    if (mx < box.x || mx > box.x + box.width || my < box.y || my > box.y + box.height) continue;
    const len = Math.hypot(x2 - x1, y2 - y1);
    // Long lines (border, match lines) can't stretch the box on their own.
    const w = Math.min(len, 12);
    if (w <= 0) continue;
    xs.push([Math.min(x1, x2), w], [Math.max(x1, x2), w]);
    ys.push([Math.min(y1, y2), w], [Math.max(y1, y2), w]);
    total += 2 * w;
  }
  if (xs.length < 400) return box;
  const pct = (vals: Array<[number, number]>, q: number) => {
    vals.sort((a, b) => a[0] - b[0]);
    let acc = 0;
    for (const [v, w] of vals) { acc += w; if (acc >= total * q) return v; }
    return vals[vals.length - 1][0];
  };
  const x0 = pct(xs, 0.004); const x1 = pct(xs, 0.996);
  const y0 = pct(ys, 0.004); const y1 = pct(ys, 0.996);
  const padX = box.width * 0.01; const padY = box.height * 0.01;
  const nx = Math.max(box.x, x0 - padX);
  const ny = Math.max(box.y, y0 - padY);
  const nx1 = Math.min(box.x + box.width, x1 + padX);
  const ny1 = Math.min(box.y + box.height, y1 + padY);
  if (nx1 - nx < box.width * 0.2 || ny1 - ny < box.height * 0.2) return box;
  return { x: nx, y: ny, width: nx1 - nx, height: ny1 - ny };
}

const COLUMN = /^\d{1,2}(?:\.\d{1,2})?$/;
const ROW = /^[A-Z]{1,2}(?:\.\d{1,2})?$/;

function bubbles(texts: Text[], box: Box) {
  const cols: Array<{ label: string; x: number; y: number }> = [];
  const rows: Array<{ label: string; x: number; y: number }> = [];
  const edgeX = box.width * 0.1;
  const edgeY = box.height * 0.16;
  for (const t of texts) {
    const label = (t.str || '').trim().toUpperCase();
    if (!label || label.length > 5) continue;
    const x = t.x + t.width / 2; const y = t.y + t.height / 2;
    if (x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) continue;
    // Column bubbles run along the top/bottom edge, row bubbles along the sides.
    const nearTopBottom = y < box.y + edgeY || y > box.y + box.height - edgeY;
    const nearSides = x < box.x + edgeX || x > box.x + box.width - edgeX;
    if (COLUMN.test(label) && nearTopBottom) cols.push({ label, x, y });
    else if (ROW.test(label) && nearSides) rows.push({ label, x, y });
  }
  return { cols, rows };
}

/** Most-agreed shift between same-named bubbles (needs `minLabels` different labels to agree). */
function agreedShift(a: Array<{ label: string; v: number }>, b: Array<{ label: string; v: number }>, tol: number, minLabels: number): number | null {
  const votes = new Map<number, Set<string>>();
  const sums = new Map<number, number[]>();
  for (const p of a) {
    for (const q of b) {
      if (p.label !== q.label) continue;
      const d = q.v - p.v;
      const key = Math.round(d / tol);
      for (const k of [key - 1, key, key + 1]) {
        votes.set(k, (votes.get(k) || new Set()).add(p.label));
        sums.set(k, [...(sums.get(k) || []), d]);
      }
    }
  }
  let best: { k: number; n: number } | null = null;
  for (const [k, labels] of votes) if (!best || labels.size > best.n || (labels.size === best.n && k < best.k)) best = { k, n: labels.size };
  if (!best || best.n < minLabels) return null;
  const ds = (sums.get(best.k) || []).filter(d => Math.abs(d - best!.k * tol) <= tol * 1.5).sort((x, y) => x - y);
  return ds.length ? ds[Math.floor(ds.length / 2)] : null;
}

/** Shift that carries a point on view `from` onto the same spot on view `to`, or null. */
export function viewOffset(texts: Text[] | undefined, from: Box, to: Box): Pt | null {
  if (!texts?.length) return null;
  const A = bubbles(texts, from);
  const B = bubbles(texts, to);
  const tol = Math.max(2, Math.max(from.width, from.height) * 0.004);
  const dx = agreedShift(A.cols.map(c => ({ label: c.label, v: c.x })), B.cols.map(c => ({ label: c.label, v: c.x })), tol, 3);
  let dy = agreedShift(A.rows.map(r => ({ label: r.label, v: r.y })), B.rows.map(r => ({ label: r.label, v: r.y })), tol, 2);
  if (dx === null) return null;
  if (dy === null) {
    // No row bubbles: the column bubble rows themselves are the same height on each plan.
    const top = (list: Array<{ y: number }>) => (list.length ? Math.min(...list.map(c => c.y)) : null);
    const ta = top(A.cols); const tb = top(B.cols);
    if (ta === null || tb === null) return null;
    dy = tb - ta;
  }
  return { x: dx, y: dy };
}

/** Point inside a box (inset a little so it sits on the drawing, not its edge). */
export function insideBox(p: Pt, box: Box, inset = 0.02): Pt {
  return {
    x: Math.min(box.x + box.width * (1 - inset), Math.max(box.x + box.width * inset, p.x)),
    y: Math.min(box.y + box.height * (1 - inset), Math.max(box.y + box.height * inset, p.y)),
  };
}
