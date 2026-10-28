/**
 * Suggested runs: given a plan sheet, the panel and the devices on each circuit, lay out
 * branch circuitry and home-run conduits that go around obstacles, then size conductors
 * (ampacity + voltage drop), EGCs and raceways per the governing NEC edition.
 *
 * Input/output points are DISPLAY POINTS of the page viewport.
 */
import type { PageZone, ZonePageInput } from '../detection/pageZones';
import { zoneAtPoint } from '../detection/pageZones';
import { footprintContains, outsideShare, type Footprint } from './footprint';
import { codeRef, formatSize, type ConductorSize, type Material, type RacewayType } from './necTables';
import {
  describeConductors,
  formatTradeSize,
  sizeCircuit,
  sizeConduit,
  type CircuitInput,
  type CircuitSizing,
  type ConduitSizing,
} from './sizing';
import {
  OrthoRouter,
  detectObstacles,
  isElevationMark,
  pathLength,
  pointIn,
  segmentHitsBox,
  simplifyOrthogonal,
  totalBendDegrees,
  type Box,
  type Obstacle,
  type Pt,
} from './spatial';

export type WiringMethod = RacewayType | 'MC';

export type RunSettings = {
  wiringMethod: WiringMethod;
  material: Material;
  vdTargetPct: number;
  maxCircuitsPerConduit: number;
  /** Vertical allowance per home run (drops/rises), feet. */
  verticalFt: number;
  necEdition: number;
};

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  wiringMethod: 'EMT',
  material: 'cu',
  vdTargetPct: 3,
  maxCircuitsPerConduit: 3,
  verticalFt: 15,
  necEdition: 2023,
};

export type PlannedCircuit = CircuitInput & { devices: Pt[]; panel?: string };

export type PlannedRun = {
  id: string;
  kind: 'homerun' | 'branch';
  circuitIds: string[];
  path: Pt[];
  /** Branch legs: [start, mid, end] of the Revit-style arc drawn between the two fixtures. */
  arc?: [Pt, Pt, Pt];
  /** Fixture the run starts at / ends at (branch: both fixtures; home run: its first fixture). */
  fromPt?: Pt;
  toPt?: Pt;
  /** Vertical riser footage included in lengthFt (panel on another floor). */
  riserFt?: number;
  lengthFt: number;
  bendsDeg: number;
  wallCrossings: number;
  label: string;
  note: string;
  conduit?: ConduitSizing;
  sizing: CircuitSizing[];
  /** Length used for voltage drop (home run + farthest branch + vertical). */
  vdLengthFt: number;
  warnings: string[];
};

export type RunPlan = {
  runs: PlannedRun[];
  obstacles: Obstacle[];
  ftPerPt: number;
  scaleSource: string;
  warnings: string[];
  codeRefs: string[];
  /** Per circuit: home-run fixture → load centre, feet (voltage-drop basis). */
  loadCenterFt?: Record<string, number>;
  /** Circuits left off because no clear route exists (nothing drawn for them). */
  blockedCircuits?: string[];
};

export type PlanRunsInput = {
  page: ZonePageInput;
  zones: PageZone[];
  panel: Pt;
  panelLabel: string;
  circuits: PlannedCircuit[];
  settings: RunSettings;
  /** Feet per display point (calibration or view scale). */
  ftPerPt: number;
  scaleSource: string;
  /** Keep-clear areas the user marked (display points). */
  extraObstacles?: Obstacle[];
  /** Home runs leave the sheet (panel is on another sheet): route to the plan-view edge. */
  panelOffSheet?: boolean;
  /**
   * The panel is on another floor: `panel` is the riser point on this floor and the home run
   * gains `riser.ft` of vertical (floor-to-floor × levels).
   */
  riser?: { ft: number; text: string };
  /** The user confirmed the keep-clear areas (extraObstacles): don't add auto-detected ones. */
  keepClearConfirmed?: boolean;
  /**
   * The sheet's floor-plan views (first / second floor…). Routing stays inside the view(s) that
   * hold this panel's devices — never across the white space to another floor.
   */
  floorViews?: Box[];
  /** Building outline: runs never leave it (no routing through white space). */
  footprint?: Footprint | null;
};

/** Plan view holding a point; points in the white space / just outside go to the nearest view. */
export function viewIndexOf(p: Pt, views: Box[]): number {
  if (!views.length) return -1;
  const inside = views.findIndex(b => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height);
  if (inside >= 0) return inside;
  let best = 0;
  let bestD = Infinity;
  views.forEach((b, i) => {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

const NON_ROUTABLE = new Set(['schedule', 'legend', 'notes', 'title_block', 'key_plan', 'revisions', 'detail', 'diagram']);

/** Plan-view routing area + keep-clear rooms (elevators, stairs, shafts) found from their labels. */
export function planRoutingContext(page: ZonePageInput, zones: PageZone[], devices: Pt[], panels: Pt[] = []): {
  allowed: Box[];
  blocked: Box[];
  obstacles: Obstacle[];
  /** Elevator / stair / shaft labels printed inside the plan view. */
  obstacleMentions: number;
} {
  const W = page.pageWidth;
  const H = page.pageHeight;
  const pct = (z: PageZone): Box => ({ x: (z.bounds.x / 100) * W, y: (z.bounds.y / 100) * H, width: (z.bounds.width / 100) * W, height: (z.bounds.height / 100) * H });
  const planViews = zones.filter(z => z.kind === 'plan' && z.source === 'view').map(pct);
  const usedViews = planViews.filter(box => devices.some(d => pointIn(d, box)) || panels.some(p => pointIn(p, box)));
  const allowed = usedViews.length ? usedViews.map(b => expand(b, Math.max(W, H) * 0.01)) : [];
  const blocked = zones.filter(z => NON_ROUTABLE.has(z.kind)).map(pct)
    .filter(box => !devices.some(d => pointIn(d, box)));
  const obstacles = detectObstacles(page, allowed.length ? allowed : undefined, blocked);
  const obstacleMentions = page.textItems.filter(item => {
    const text = item.str.trim();
    if (text.length > 30 || !/\b(ELEV(ATOR)?|STAIRS?|STAIRWELL|SHAFT|CHASE)\b/i.test(text)) return false;
    if (/\bELEV/i.test(text) && !/STAIR|SHAFT|CHASE/i.test(text) && isElevationMark(text)) return false;
    const c = { x: item.x + item.width / 2, y: item.y + item.height / 2 };
    return (!allowed.length || allowed.some(box => pointIn(c, box))) && !blocked.some(box => pointIn(c, box));
  }).length;
  return { allowed, blocked, obstacles, obstacleMentions };
}

/** Point on the plan-view edge nearest the devices' centroid (home runs that leave the sheet). */
export function offSheetExitPoint(allowed: Box[], devices: Pt[], page: ZonePageInput): Pt {
  const cx = devices.reduce((sum, d) => sum + d.x, 0) / Math.max(1, devices.length);
  const cy = devices.reduce((sum, d) => sum + d.y, 0) / Math.max(1, devices.length);
  const box = allowed.find(b => pointIn({ x: cx, y: cy }, b)) || allowed[0] || { x: 0, y: 0, width: page.pageWidth, height: page.pageHeight };
  const inset = Math.max(page.pageWidth, page.pageHeight) * 0.012;
  const options: Pt[] = [
    { x: box.x + inset, y: cy },
    { x: box.x + box.width - inset, y: cy },
    { x: cx, y: box.y + inset },
    { x: cx, y: box.y + box.height - inset },
  ];
  return options.reduce((best, p) => (dist(p, { x: cx, y: cy }) < dist(best, { x: cx, y: cy }) ? p : best), options[0]);
}

export class RunRoutingError extends Error {
  constructor(public readonly circuitIds: string[]) {
    super(`No clear route for ${circuitIds.join(', ')}. Your panels and keep-clear zones have not been moved. Review the destination and keep-clear boundaries on this plan before retrying; no fallback line was drawn.`);
    this.name = 'RunRoutingError';
  }
}

export function planRuns(input: PlanRunsInput): RunPlan {
  const { page, zones, settings } = input;
  const W = page.pageWidth;
  const H = page.pageHeight;
  const warnings: string[] = [];

  // Route only inside the plan view that holds the devices (or the whole sheet if none).
  const allDevices = input.circuits.flatMap(c => c.devices);
  const context = planRoutingContext(page, zones, allDevices, [input.panel]);
  const { blocked } = context;
  let allowed = context.allowed;
  if (input.floorViews && input.floorViews.length > 1) {
    const used = new Set([input.panel, ...allDevices].map(p => viewIndexOf(p, input.floorViews as Box[])));
    const pad = Math.max(W, H) * 0.006;
    allowed = [...used].map(i => expand((input.floorViews as Box[])[i], pad));
  }
  const obstacles = [...(input.keepClearConfirmed ? [] : context.obstacles), ...(input.extraObstacles || [])];
  // Devices or the panel inside an obstacle footprint must not be walled in.
  // Auto-detected ones are dropped then; the user's keep-clear boxes always stand (the router
  // steps out of a box from the nearest free cell).
  const userBoxes = new Set((input.extraObstacles || []).map(o => o.box));
  const obstacleBoxes = obstacles.map(o => o.box).filter(box => userBoxes.has(box) || (!pointIn(input.panel, box) && !allDevices.some(d => pointIn(d, box))));
  // A drawn arc must respect the keep-clear areas too, not just the routed footage path.
  const arcHits = (a: Pt, mid: Pt, b: Pt) => {
    const c = { x: 2 * mid.x - (a.x + b.x) / 2, y: 2 * mid.y - (a.y + b.y) / 2 };
    const pts: Pt[] = [];
    for (let i = 0; i <= 16; i += 1) {
      const t = i / 16;
      pts.push({ x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y });
    }
    // An arc that swings out past the exterior wall into the white space is not drawn.
    if (input.footprint && footprintContains(input.footprint, a) && footprintContains(input.footprint, b)
      && outsideShare(input.footprint, pts) > 0.02) return true;
    return obstacleBoxes.some(box => {
      const inner = shrink(box, 1);
      if (pointIn(a, inner) || pointIn(b, inner)) return false;
      return pts.some((p, i) => i + 1 < pts.length && segmentHitsBox(p, pts[i + 1], inner));
    });
  };
  const router = new OrthoRouter({ width: W, height: H, segments: page.segments, obstacles: obstacleBoxes, allowed, blocked, footprint: input.footprint });

  const runs: PlannedRun[] = [];
  const blockedCircuits: string[] = [];
  const codeRefs = new Set<string>();
  const ed = settings.necEdition;

  // 1. Branch circuitry per circuit: chain devices nearest-neighbour from the far end.
  const circuitLegs = new Map<string, { homeDevice: Pt; branchFt: number; farthestFt: number; loadCenterFt: number }>();
  const bulgeMax = Math.max(W, H) * 0.02;
  for (const circuit of input.circuits) {
    if (!circuit.devices.length) continue;
    const order = chainDevices(circuit.devices, input.panel);
    let branchPts = 0;
    let farthest = 0;
    const firstLeg = runs.length;
    let routed = true;
    for (let i = 0; i + 1 < order.length; i += 1) {
      const leg = router.route(order[i], order[i + 1]);
      if (!leg.ok) { routed = false; break; }
      const len = pathLength(leg.path);
      branchPts += len;
      // Drawn like Revit wiring: an arc from fixture to fixture (bulging to one side); footage is
      // the routed length between them.
      const a = order[i];
      const b = order[i + 1];
      const chord = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const bulge = Math.min(chord * 0.18, bulgeMax);
      let mid = { x: (a.x + b.x) / 2 - ((b.y - a.y) / chord) * bulge, y: (a.y + b.y) / 2 + ((b.x - a.x) / chord) * bulge };
      let arc: [Pt, Pt, Pt] | undefined = [a, mid, b];
      if (arcHits(a, mid, b)) {
        // Bulge the other way; if that also clips a keep-clear box, draw the routed path.
        mid = { x: (a.x + b.x) / 2 + ((b.y - a.y) / chord) * bulge, y: (a.y + b.y) / 2 - ((b.x - a.x) / chord) * bulge };
        arc = arcHits(a, mid, b) ? undefined : [a, mid, b];
      }
      runs.push({
        id: `${circuit.id}-b${i + 1}`,
        kind: 'branch',
        circuitIds: [circuit.id],
        path: leg.path,
        ...(arc ? { arc } : {}),
        fromPt: a,
        toPt: b,
        lengthFt: round1(len * input.ftPerPt),
        bendsDeg: totalBendDegrees(leg.path),
        wallCrossings: leg.wallCrossings,
        label: '',
        note: '',
        sizing: [],
        vdLengthFt: 0,
        warnings: leg.ok ? [] : ['No clear path found — straight-line fallback; adjust by hand.'],
      });
    }
    if (!routed) {
      // One blocked circuit never sinks the rest: it's left off (no fallback line) and listed.
      runs.splice(firstLeg);
      blockedCircuits.push(circuit.id);
      continue;
    }
    farthest = branchPts;
    // Fixtures are spread along the branch: voltage drop is computed to the load centre (average
    // distance from the home-run fixture), not as if every fixture sat at the far end.
    let along = 0;
    let sumAlong = 0;
    for (let i = order.length - 1; i > 0; i -= 1) {
      along += manhattan(order[i], order[i - 1]);
      sumAlong += along;
    }
    const loadCenterPts = order.length > 1 ? Math.min(branchPts, (sumAlong / order.length) * (branchPts / Math.max(1e-6, along))) : 0;
    circuitLegs.set(circuit.id, {
      homeDevice: order[order.length - 1],
      branchFt: branchPts * input.ftPerPt,
      farthestFt: farthest * input.ftPerPt,
      loadCenterFt: loadCenterPts * input.ftPerPt,
    });
  }

  // 2. Group circuits into home-run conduits by direction from the panel.
  const groups = groupCircuits(input.circuits.filter(c => circuitLegs.has(c.id)), input.panel, settings);
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const legs = group.map(c => circuitLegs.get(c.id) as { homeDevice: Pt; branchFt: number; farthestFt: number; loadCenterFt: number });
    // Home run starts at the group's device closest to the panel.
    const startLeg = legs.reduce((best, leg) => dist(leg.homeDevice, input.panel) < dist(best.homeDevice, input.panel) ? leg : best, legs[0]);
    // A shared home run must physically collect EVERY circuit, not merely list its ID.
    // Route each other string to the shared start. If collection fails, try separate home
    // runs instead; never invent a connector through a blocked area.
    const collectors = legs.map(leg => dist(leg.homeDevice, startLeg.homeDevice) < 1e-6
      ? null : router.route(leg.homeDevice, startLeg.homeDevice));
    const route = router.route(startLeg.homeDevice, input.panel);
    if (!route.ok || collectors.some(leg => leg && !leg.ok)) {
      if (group.length > 1) {
        groups.push(...group.map(c => [c]));
        continue;
      }
      // The group's branch strings are dropped with it: nothing is drawn that can't reach the panel.
      const ids = new Set(group.map(c => c.id));
      for (let i = runs.length - 1; i >= 0; i -= 1) if (runs[i].kind === 'branch' && ids.has(runs[i].circuitIds[0])) runs.splice(i, 1);
      blockedCircuits.push(...ids);
      continue;
    }
    collectors.forEach((leg, i) => {
      if (!leg) return;
      const ft = pathLength(leg.path) * input.ftPerPt;
      legs[i] = { ...legs[i], branchFt: legs[i].branchFt + ft, farthestFt: legs[i].farthestFt + ft, loadCenterFt: legs[i].loadCenterFt + ft };
      circuitLegs.set(group[i].id, legs[i]);
      runs.push({
        id: `${group[i].id}-collector`, kind: 'branch', circuitIds: [group[i].id],
        path: leg.path, fromPt: legs[i].homeDevice, toPt: startLeg.homeDevice,
        lengthFt: round1(ft), bendsDeg: totalBendDegrees(leg.path), wallCrossings: leg.wallCrossings,
        label: '', note: 'Connects this circuit to the shared home run.',
        sizing: [], vdLengthFt: 0, warnings: [],
      });
    });
    router.markUsed(route.path);
    const riserFt = input.riser?.ft || 0;
    const homeFt = pathLength(route.path) * input.ftPerPt + riserFt;
    const bends = totalBendDegrees(route.path);
    const runWarnings: string[] = [];
    if (!route.ok) runWarnings.push('No clear path found — straight-line fallback; adjust by hand.');

    const isCable = settings.wiringMethod === 'MC';
    const ccc = group.reduce((sum, c) => sum + (c.phase === 3 ? 3 : 2), 0);
    const sizing = group.map((circuit, i) => {
      const vdLength = homeFt + legs[i].loadCenterFt + settings.verticalFt;
      return sizeCircuit(circuit, vdLength, isCable ? (circuit.phase === 3 ? 3 : 2) : ccc, {
        material: settings.material,
        vdTargetPct: settings.vdTargetPct,
        necEdition: ed,
      });
    });
    const vdLengthFt = Math.max(...group.map((_, i) => homeFt + legs[i].loadCenterFt + settings.verticalFt));
    codeRefs.add(codeRef(ed, 'ampacity'));
    codeRefs.add(codeRef(ed, 'vdBranch'));
    codeRefs.add(codeRef(ed, 'egc'));
    if (ccc > 3 && !isCable) codeRefs.add(codeRef(ed, 'adjust'));

    let conduit: ConduitSizing | undefined;
    let label: string;
    if (isCable) {
      label = sizing.map(s => `MC ${formatSize(s.conductor).replace('#', '')}/${s.ccc}+G`).join(' · ');
    } else {
      const raceway = settings.wiringMethod as RacewayType;
      const conductors = conductorsForGroup(group, sizing);
      conduit = sizeConduit(conductors, raceway);
      codeRefs.add(codeRef(ed, 'fill'));
      label = `${formatTradeSize(conduit.tradeSize, raceway)} – ${describeConductors(conductors)}`;
      if (bends > 360) {
        runWarnings.push(`${bends}° of bends — add a pull box (max 360° between pull points, ${raceway === 'EMT' ? '358.26' : raceway === 'PVC40' ? '352.26' : '344.26'}).`);
        codeRefs.add(raceway === 'EMT' ? '358.26' : raceway === 'PVC40' ? '352.26' : '344.26');
      }
    }
    const circuitsLabel = group.map(c => c.label || c.id).join(', ');
    const worstVd = Math.max(...sizing.map(s => s.vdPct));
    const note = [
      `Home run ${index + 1} → ${input.panelLabel}: ${circuitsLabel}`,
      label,
      ...(input.riser ? [`Riser ${input.riser.text}: +${Math.round(riserFt)} ft vertical included`] : []),
      `≈${Math.round(homeFt)} ft home run (${Math.round(vdLengthFt)} ft to the load centre incl. ${settings.verticalFt} ft vertical) · VD ${worstVd.toFixed(1)}%`,
      ...sizing.flatMap(s => s.notes),
      ...runWarnings,
    ].join('\n');
    runs.push({
      id: `HR${index + 1}`,
      kind: 'homerun',
      circuitIds: group.map(c => c.id),
      path: route.path,
      lengthFt: round1(homeFt),
      bendsDeg: bends,
      wallCrossings: route.wallCrossings,
      label: `HR${index + 1} ${shortCircuitList(group.map(c => c.label || c.id))}: ${label}${input.riser ? ` ${input.riser.text}` : ''}`,
      fromPt: { ...startLeg.homeDevice },
      ...(riserFt ? { riserFt: round1(riserFt) } : {}),
      note,
      conduit,
      sizing,
      vdLengthFt: round1(vdLengthFt),
      warnings: runWarnings,
    });
    warnings.push(...runWarnings.map(w => `HR${index + 1}: ${w}`));
  }

  // Offset parallel conduits so they read as separate runs — but never into a keep-clear zone.
  const homeRuns = runs.filter(r => r.kind === 'homerun');
  const before = new Map(homeRuns.map(r => [r, r.path.map(p => ({ ...p }))]));
  offsetParallelHomeRuns(homeRuns, Math.max(W, H) / 400);
  const crosses = (path: Pt[]) => obstacleBoxes.some(box => path.some((p, i) => i + 1 < path.length && segmentHitsBox(p, path[i + 1], shrink(box, 2))));
  for (const run of homeRuns) {
    const original = before.get(run)!;
    if ((crosses(run.path) || router.blockedAlong(run.path)) && !crosses(original)) run.path = original;
    // Footage always equals what's drawn (+ riser), so editing / re-running agrees to the foot.
    const drawnFt = pathLength(run.path) * input.ftPerPt + (run.riserFt || 0);
    if (Math.abs(drawnFt - run.lengthFt) > 0.05) run.lengthFt = round1(drawnFt);
  }

  // Safety: no run may cross an obstacle footprint.
  for (const run of runs) {
    for (const ob of obstacles) {
      if (obstacleBoxes.includes(ob.box) && run.path.some((p, i) => i + 1 < run.path.length && segmentHitsBox(p, run.path[i + 1], shrink(ob.box, 2)))) {
        run.warnings.push(`Crosses ${ob.label} — reroute by hand.`);
      }
    }
  }
  const withDevices = input.circuits.filter(c => c.devices.length).length;
  if (blockedCircuits.length && blockedCircuits.length >= withDevices) throw new RunRoutingError(blockedCircuits);
  if (blockedCircuits.length) warnings.push(`Not routed (no clear path without crossing a keep-clear zone or leaving the building): ${blockedCircuits.join(', ')}. Nothing was drawn for ${blockedCircuits.length === 1 ? 'it' : 'them'}.`);
  if (!obstacles.length) warnings.push('No elevators, shafts or stairs were labeled on this view.');
  if (input.panelOffSheet) warnings.push(`Panel ${input.panelLabel} is on another sheet: home runs stop at the plan edge; add the remaining length from that sheet.`);
  const loadCenterFt = Object.fromEntries([...circuitLegs.entries()].map(([id, leg]) => [id, round1(leg.loadCenterFt)]));
  return { runs, obstacles, ftPerPt: input.ftPerPt, scaleSource: input.scaleSource, warnings, codeRefs: [...codeRefs], loadCenterFt, ...(blockedCircuits.length ? { blockedCircuits } : {}) };
}

function conductorsForGroup(group: PlannedCircuit[], sizing: CircuitSizing[]): ConduitSizing['conductors'] {
  const rows = new Map<string, { size: ConductorSize; count: number; role: 'phase' | 'neutral' | 'egc' }>();
  const add = (size: ConductorSize, count: number, role: 'phase' | 'neutral' | 'egc') => {
    const key = `${role}:${size}`;
    const row = rows.get(key) || { size, count: 0, role };
    row.count += count;
    rows.set(key, row);
  };
  group.forEach((circuit, i) => {
    const s = sizing[i];
    if (circuit.phase === 3) add(s.conductor, 3, 'phase');
    else { add(s.conductor, 1, 'phase'); add(s.conductor, 1, 'neutral'); }
  });
  // One EGC sized for the largest circuit in the raceway (250.122(C)).
  const largestEgc = sizing.map(s => s.egc).sort((a, b) => sizeRank(b) - sizeRank(a))[0];
  if (largestEgc) add(largestEgc, 1, 'egc');
  const merged = new Map<string, { size: ConductorSize; count: number; role: 'phase' | 'neutral' | 'egc' }>();
  for (const row of rows.values()) {
    const role = row.role === 'egc' ? 'egc' : 'phase';
    const key = `${role}:${row.size}`;
    const m = merged.get(key) || { size: row.size, count: 0, role };
    m.count += row.count;
    merged.set(key, m);
  }
  return [...merged.values()];
}

function sizeRank(size: ConductorSize): number {
  return ['14', '12', '10', '8', '6', '4', '3', '2', '1', '1/0', '2/0', '3/0', '4/0', '250', '300', '350', '400', '500', '600', '750'].indexOf(size);
}

/** Order devices into a chain that ends at the device nearest the panel. */
export function chainDevices(devices: Pt[], panel: Pt): Pt[] {
  if (devices.length <= 1) return devices.slice();
  const remaining = devices.slice();
  remaining.sort((a, b) => dist(b, panel) - dist(a, panel));
  const chain = [remaining.shift() as Pt];
  while (remaining.length) {
    const last = chain[chain.length - 1];
    let bi = 0;
    for (let i = 1; i < remaining.length; i += 1) if (manhattan(remaining[i], last) < manhattan(remaining[bi], last)) bi = i;
    chain.push(remaining.splice(bi, 1)[0]);
  }
  // Make sure the panel-side end is the device nearest the panel.
  if (dist(chain[0], panel) < dist(chain[chain.length - 1], panel)) chain.reverse();
  return chain;
}

/** Circuits heading the same way from the panel share a home run, up to the per-conduit limit. */
function groupCircuits(circuits: PlannedCircuit[], panel: Pt, settings: RunSettings): PlannedCircuit[][] {
  if (settings.wiringMethod === 'MC') return circuits.map(c => [c]);
  const withAngle = circuits.map(c => {
    const cx = c.devices.reduce((s, d) => s + d.x, 0) / c.devices.length;
    const cy = c.devices.reduce((s, d) => s + d.y, 0) / c.devices.length;
    return { c, angle: Math.atan2(cy - panel.y, cx - panel.x) };
  }).sort((a, b) => a.angle - b.angle);
  const groups: PlannedCircuit[][] = [];
  let current: PlannedCircuit[] = [];
  let lastAngle = -Infinity;
  for (const row of withAngle) {
    const sameWay = row.angle - lastAngle < Math.PI / 6;
    const samePhase = !current.length || current[0].phase === row.c.phase && current[0].voltage === row.c.voltage;
    if (current.length && (!sameWay || !samePhase || current.length >= settings.maxCircuitsPerConduit)) {
      groups.push(current);
      current = [];
    }
    current.push(row.c);
    lastAngle = row.angle;
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Shift home runs that share segments sideways so each conduit is visible. */
function offsetParallelHomeRuns(runs: PlannedRun[], spacing: number): void {
  const segKey = (a: Pt, b: Pt) => {
    const horizontal = Math.abs(a.y - b.y) < 1e-6;
    return horizontal ? `h:${Math.round(a.y / spacing)}` : `v:${Math.round(a.x / spacing)}`;
  };
  const seen = new Map<string, number>();
  for (const run of runs) {
    const path = run.path.map(p => ({ ...p }));
    for (let i = 0; i + 1 < path.length; i += 1) {
      const a = path[i]; const b = path[i + 1];
      const key = segKey(a, b);
      const k = seen.get(key) || 0;
      seen.set(key, k + 1);
      if (!k || i === 0 || i + 1 === path.length - 1) continue; // keep endpoints on devices/panel
      const off = k * spacing;
      if (Math.abs(a.y - b.y) < 1e-6) { a.y += off; b.y += off; } else { a.x += off; b.x += off; }
    }
    run.path = simplifyOrthogonal(path);
  }
}

/** Parse a drawing scale ('1/8" = 1\'-0"', '1" = 20\'') to feet per display point. */
export function parseScaleFtPerPt(text: string): number | null {
  const arch = text.match(/(\d+)\s*\/\s*(\d+)\s*"\s*=\s*1\s*'\s*-?\s*0?\s*"?/);
  if (arch) {
    const inchesPerFoot = Number(arch[1]) / Number(arch[2]);
    return inchesPerFoot > 0 ? 1 / (inchesPerFoot * 72) : null;
  }
  const archWhole = text.match(/(\d+(?:\.\d+)?)\s*"\s*=\s*1\s*'\s*-?\s*0?\s*"?/);
  if (archWhole) {
    const inchesPerFoot = Number(archWhole[1]);
    return inchesPerFoot > 0 ? 1 / (inchesPerFoot * 72) : null;
  }
  const eng = text.match(/1\s*"\s*=\s*(\d+(?:\.\d+)?)\s*'/);
  if (eng) return Number(eng[1]) / 72;
  return null;
}

/** Scale of the plan view containing most devices (nearest scale text under its title). */
export function findViewScale(page: ZonePageInput, zones: PageZone[], devices: Pt[]): { ftPerPt: number; text: string } | null {
  const W = page.pageWidth;
  const H = page.pageHeight;
  const scales = page.textItems
    .map(item => ({ item, ftPerPt: parseScaleFtPerPt(item.str) }))
    .filter((row): row is { item: typeof row.item; ftPerPt: number } => row.ftPerPt !== null);
  if (!scales.length) return null;
  const view = zones
    .filter(z => z.kind === 'plan' && z.source === 'view')
    .map(z => ({ z, n: devices.filter(d => zoneAtPoint([z], (d.x / W) * 100, (d.y / H) * 100)).length }))
    .sort((a, b) => b.n - a.n)[0]?.z;
  const anchor = view
    ? { x: (view.bounds.x / 100) * W, y: ((view.bounds.y + view.bounds.height) / 100) * H }
    : { x: W / 2, y: H };
  const best = scales.sort((a, b) => dist(a.item, anchor) - dist(b.item, anchor))[0];
  return { ftPerPt: best.ftPerPt, text: best.item.str.trim() };
}

function expand(b: Box, d: number): Box {
  return { x: b.x - d, y: b.y - d, width: b.width + 2 * d, height: b.height + 2 * d };
}

function shrink(b: Box, d: number): Box {
  return { x: b.x + d, y: b.y + d, width: Math.max(0, b.width - 2 * d), height: Math.max(0, b.height - 2 * d) };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function manhattan(a: Pt, b: Pt): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** "B-4, B-6, B-8" → "B-4,6,8" (how home-run arrows are tagged on plans). */
export function shortCircuitList(ids: string[]): string {
  const byPanel = new Map<string, string[]>();
  const loose: string[] = [];
  for (const id of ids) {
    const m = id.match(/^(.+?)-(\d[\d,]*)$/);
    if (!m) { loose.push(id); continue; }
    byPanel.set(m[1], [...(byPanel.get(m[1]) || []), m[2]]);
  }
  return [...[...byPanel.entries()].map(([panel, nums]) => `${panel}-${nums.join(',')}`), ...loose].join(' ');
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
