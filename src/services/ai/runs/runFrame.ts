/**
 * Coordinate frames for suggested runs.
 *
 *  - Plan frame: page display points (PDF viewport at scale 1, rotation applied). Zoning, vector
 *    segments, text, the footprint mask and the router all work here, and card picks (page %)
 *    map straight into it.
 *  - Canvas frame: where every markup is stored and drawn — the page rendered at
 *    BASE_RENDER_SCALE with rotation applied (count markers, rectangles, polylines…).
 *
 * The two differ by exactly BASE_RENDER_SCALE (both already include the page rotation), so a
 * point converts by a single scale. Run markups written before this module existed were stored
 * in unrotated PDF points; they are read back in that frame and upgraded on the next placement.
 */
import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';
import { docToRender } from '@/services/ai/placement/coords';
import type { PageGeometry } from '@/services/ai/placement/types';
import type { CanvasMarkup, Point } from '@/types/markup';
import type { Box, Pt } from './spatial';

export const CANVAS_SCALE = BASE_RENDER_SCALE;

export const toCanvas = (p: Pt, k = CANVAS_SCALE): Pt => ({ x: p.x * k, y: p.y * k });
export const fromCanvas = (p: Pt, k = CANVAS_SCALE): Pt => ({ x: p.x / k, y: p.y / k });

type WithRun = { aiRun?: { frame?: 'render' } };

/** Run markup written by an older version (unrotated PDF points). */
export function isLegacyRunMarkup(m: CanvasMarkup): boolean {
  const run = (m as WithRun).aiRun;
  return !!run && run.frame !== 'render';
}

/** Plan-frame point for a stored markup point. */
export function markupPointToPlan(m: CanvasMarkup, p: Pt, geometry: PageGeometry, k = CANVAS_SCALE): Pt {
  if (!isLegacyRunMarkup(m)) return fromCanvas(p, k);
  // Legacy: unrotated PDF points → display (rotation applied, scale 1).
  return docToRender(p, { ...geometry, renderScale: 1 });
}

/** Plan-frame box of a stored rectangle / ellipse markup. */
export function markupBoxToPlan(m: CanvasMarkup, geometry: PageGeometry, k = CANVAS_SCALE): Box {
  const r = m as unknown as { x: number; y: number; width: number; height: number };
  const a = markupPointToPlan(m, { x: r.x, y: r.y }, geometry, k);
  const b = markupPointToPlan(m, { x: r.x + r.width, y: r.y + r.height }, geometry, k);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/**
 * Same markup re-expressed in the canvas frame (legacy run markups only; others unchanged).
 * The id is kept so the caller can swap it in place.
 */
export function upgradeLegacyRunMarkup(m: CanvasMarkup, geometry: PageGeometry, k = CANVAS_SCALE): CanvasMarkup {
  if (!isLegacyRunMarkup(m)) return m;
  const run = (m as unknown as { aiRun: { ftPerPt?: number } }).aiRun;
  // Lengths are re-derived from the drawn points × ftPerPt: one legacy unit (a PDF point) is k
  // canvas units, so ftPerPt shrinks by k and every length stays the same.
  const aiRun = { ...run, frame: 'render' as const, ...(typeof run.ftPerPt === 'number' ? { ftPerPt: run.ftPerPt / k } : {}) };
  const toC = (p: Pt) => toCanvas(markupPointToPlan(m, p, geometry, k), k);
  const pts = (m as unknown as { points?: Point[] }).points;
  if (Array.isArray(pts)) {
    return { ...m, points: pts.map(p => ({ ...p, ...toC(p) })), aiRun } as CanvasMarkup;
  }
  const r = m as unknown as { x?: number; y?: number; width?: number; height?: number };
  if (typeof r.x === 'number' && typeof r.y === 'number') {
    const box = markupBoxToPlan(m, geometry, k);
    return { ...m, x: box.x * k, y: box.y * k, width: box.width * k, height: box.height * k, aiRun } as CanvasMarkup;
  }
  return m;
}
