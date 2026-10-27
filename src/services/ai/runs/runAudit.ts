/**
 * Self-check of a suggested-run layout before it's shown. Every run is tested against the rules
 * an estimator would check by eye; anything that fails is listed (and the model must say so).
 */
import type { Box, Pt } from './spatial';
import { outsideShare, type Footprint } from './footprint';

type AuditRun = { id: string; kind: 'homerun' | 'branch'; path: Pt[]; arc?: [Pt, Pt, Pt]; lengthFt: number; riserFt?: number; label?: string };

export interface RunAudit {
  checked: number;
  /** Plain-language problems, one per run/issue. */
  flagged: string[];
  /** Plain-language checks that passed. */
  passed: string[];
}

const pathLength = (path: Pt[]) => path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);

function hitsBox(a: Pt, b: Pt, box: Box): boolean {
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
  for (let s = 0; s <= steps; s += 1) {
    const x = a.x + ((b.x - a.x) * s) / steps; const y = a.y + ((b.y - a.y) * s) / steps;
    if (x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height) return true;
  }
  return false;
}

function arcPoints([a, m, b]: [Pt, Pt, Pt]): Pt[] {
  const c = { x: 2 * m.x - (a.x + b.x) / 2, y: 2 * m.y - (a.y + b.y) / 2 };
  return Array.from({ length: 17 }, (_, i) => {
    const t = i / 16;
    return { x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y };
  });
}

export function auditRuns(
  runs: AuditRun[],
  options: { ftPerPt: number; floorViews?: Box[]; keepClear?: Array<{ label: string; box: Box }>; pageMax: number; footprint?: Footprint | null },
): RunAudit {
  const flagged: string[] = [];
  const name = (r: AuditRun) => (r.kind === 'homerun' ? r.id : `${r.id.replace(/-b\d+$/, '')} branch`);
  const pad = options.pageMax * 0.012;
  const views = (options.floorViews || []).map(v => ({ x: v.x - pad, y: v.y - pad, width: v.width + 2 * pad, height: v.height + 2 * pad }));
  const inBox = (p: Pt, b: Box) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;

  let offPlan = 0; let zoneHits = 0; let footage = 0; let whiteSpace = 0;
  for (const run of runs) {
    const drawn = run.arc ? arcPoints(run.arc) : run.path;
    // 1. A run stays on one floor's plan (a floor change is a riser, never a line across the gap).
    if (views.length > 1 && drawn.length) {
      const home = views.findIndex(v => drawn.every(p => inBox(p, v)));
      if (home < 0) { offPlan += 1; flagged.push(`${name(run)} leaves its floor plan (crosses white space) — move it onto the plan.`); }
    }
    // 1b. Inside the building: no stretch of the run out in the white space around the plan
    // (a fixture just outside an exterior wall still gets its short stub).
    if (options.footprint && drawn.length > 1) {
      const out = outsideShare(options.footprint, drawn);
      const len = pathLength(drawn) * options.ftPerPt;
      if (out > 0.02 && out * len > 3) {
        whiteSpace += 1;
        flagged.push(`${name(run)} runs ${Math.round(out * 100)}% outside the building (white space) — reroute it inside.`);
      }
    }
    // 2. Keep-clear zones.
    for (const zone of options.keepClear || []) {
      const inner = { x: zone.box.x + 1, y: zone.box.y + 1, width: zone.box.width - 2, height: zone.box.height - 2 };
      if (inner.width <= 0 || inner.height <= 0) continue;
      if (drawn.some((p, i) => i + 1 < drawn.length && hitsBox(p, drawn[i + 1], inner))) {
        zoneHits += 1;
        flagged.push(`${name(run)} passes through keep-clear zone "${zone.label}".`);
      }
    }
    // 3. Footage equals the routed path (+ riser) to the tenth of a foot.
    if (run.kind === 'homerun') {
      const expected = pathLength(run.path) * options.ftPerPt + (run.riserFt || 0);
      if (Math.abs(expected - run.lengthFt) > Math.max(0.15, expected * 0.01)) {
        footage += 1;
        flagged.push(`${name(run)} footage (${run.lengthFt} ft) doesn't match its drawn path (${Math.round(expected * 10) / 10} ft).`);
      }
    }
  }
  // 4. A fixture-to-fixture jump far longer than the rest is usually a wrong pairing.
  const branchFt = runs.filter(r => r.kind === 'branch').map(r => r.lengthFt).sort((a, b) => a - b);
  let jumps = 0;
  if (branchFt.length >= 5) {
    const median = branchFt[Math.floor(branchFt.length / 2)];
    for (const run of runs) {
      if (run.kind !== 'branch') continue;
      if (run.lengthFt > Math.max(40, median * 4)) { jumps += 1; flagged.push(`${name(run)} has a ${Math.round(run.lengthFt)} ft jump between fixtures (typical ${Math.round(median)} ft) — check the circuit pairing.`); }
    }
  }
  const passed = [
    ...(views.length > 1 && !offPlan ? ['Every run stays on its own floor plan; floor changes use risers.'] : []),
    ...(options.footprint && !whiteSpace ? ['Every run stays inside the building outline (no white space).'] : []),
    ...((options.keepClear || []).length && !zoneHits ? [`No run enters the ${(options.keepClear || []).length} keep-clear zone(s).`] : []),
    ...(!footage ? ['Home-run footage matches the drawn paths.'] : []),
    ...(branchFt.length >= 5 && !jumps ? ['No unusual fixture-to-fixture jumps.'] : []),
  ];
  return { checked: runs.length, flagged, passed };
}
