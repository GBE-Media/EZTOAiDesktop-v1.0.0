/**
 * Suggested runs are tied to the count markers they string together (aiRun.anchors). When the
 * user moves a fixture, the ends of its branch arcs / home run follow it.
 */
import type { CanvasMarkup, PolygonMarkup } from '@/types/markup';
import { isRunMarkup, recomputeRunMarkup } from './overlay';

type Pt = { x: number; y: number };

export type AnchoredRunUpdate = {
  id: string;
  updates: Partial<CanvasMarkup>;
  /** New footage for the linked product measurement. */
  lengthFt?: number;
};

function markerPoint(m: CanvasMarkup): Pt | null {
  if (m.type !== 'count-marker') return null;
  const { x, y } = m as unknown as { x?: number; y?: number };
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
}

/** Re-bend an arc [a, mid, b] onto new ends, keeping the same side and relative bulge. */
export function rebendArc(old: [Pt, Pt, Pt], a: Pt, b: Pt): [Pt, Pt, Pt] {
  const [oa, om, ob] = old;
  const oldChord = Math.hypot(ob.x - oa.x, ob.y - oa.y) || 1;
  // Signed perpendicular offset of the old middle point from the old chord's midpoint.
  const nx = -(ob.y - oa.y) / oldChord;
  const ny = (ob.x - oa.x) / oldChord;
  const bulge = (om.x - (oa.x + ob.x) / 2) * nx + (om.y - (oa.y + ob.y) / 2) * ny;
  const ratio = bulge / oldChord;
  const chord = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const px = -(b.y - a.y) / chord;
  const py = (b.x - a.x) / chord;
  const d = ratio * chord;
  return [{ ...a }, { x: (a.x + b.x) / 2 + px * d, y: (a.y + b.y) / 2 + py * d }, { ...b }];
}

/** Move the first point of an orthogonal home run, keeping its first leg square. */
export function moveRunStart(points: Pt[], to: Pt): Pt[] {
  if (points.length < 2) return [{ ...to }];
  const [p0, p1, ...rest] = points;
  const horizontal = Math.abs(p0.y - p1.y) <= Math.abs(p0.x - p1.x);
  if (points.length === 2) {
    // Add an elbow so the run stays orthogonal.
    const elbow = horizontal ? { x: p1.x, y: to.y } : { x: to.x, y: p1.y };
    return [{ ...to }, elbow, { ...p1 }];
  }
  const next = horizontal ? { x: p1.x, y: to.y } : { x: to.x, y: p1.y };
  return [{ ...to }, next, ...rest.map(p => ({ ...p }))];
}

/**
 * Updates for every run tied to one of the moved count markers on this page.
 * Pure: the caller applies the updates (one history step per run).
 */
export function followAnchoredRuns(pageMarkups: CanvasMarkup[], movedMarkerIds: string[]): AnchoredRunUpdate[] {
  if (!movedMarkerIds.length) return [];
  const moved = new Set(movedMarkerIds);
  const markers = new Map<string, Pt>();
  for (const m of pageMarkups) {
    if (!moved.has(m.id)) continue;
    const p = markerPoint(m);
    if (p) markers.set(m.id, p);
  }
  if (!markers.size) return [];
  const out: AnchoredRunUpdate[] = [];
  for (const m of pageMarkups) {
    if (!isRunMarkup(m)) continue;
    const anchors = m.aiRun.anchors;
    if (!anchors) continue;
    const start = anchors.start ? markers.get(anchors.start) : undefined;
    const end = anchors.end ? markers.get(anchors.end) : undefined;
    if (!start && !end) continue;
    let points: Pt[] = m.points.map(p => ({ ...p }));
    if (m.aiRun.curve && points.length === 3) {
      points = rebendArc(points as [Pt, Pt, Pt], start || points[0], end || points[2]);
    } else {
      if (start) points = moveRunStart(points, start);
      if (end) points = [...moveRunStart([...points].reverse(), end)].reverse();
    }
    const next = { ...m, points } as PolygonMarkup;
    const recomputed = recomputeRunMarkup(next);
    out.push({
      id: m.id,
      updates: {
        points,
        ...(recomputed ? { label: recomputed.label, aiNote: recomputed.aiNote, aiRun: recomputed.aiRun } : {}),
      } as Partial<CanvasMarkup>,
      lengthFt: recomputed?.aiRun.lengthFt,
    });
  }
  return out;
}
