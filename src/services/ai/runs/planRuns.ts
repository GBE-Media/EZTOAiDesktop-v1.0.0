/**
 * Suggested runs: given a plan sheet, the panel and the devices on each circuit, lay out
 * branch circuitry and home-run conduits that go around obstacles, then size conductors
 * (ampacity + voltage drop), EGCs and raceways per the governing NEC edition.
 *
 * Input/output points are DISPLAY POINTS of the page viewport.
 */
import type { PageZone, ZonePageInput } from '../detection/pageZones';
import { zoneAtPoint } from '../detection/pageZones';
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
};

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

export function planRuns(input: PlanRunsInput): RunPlan {
  const { page, zones, settings } = input;
  const W = page.pageWidth;
  const H = page.pageHeight;
  const warnings: string[] = [];

  // Route only inside the plan view that holds the devices (or the whole sheet if none).
  const allDevices = input.circuits.flatMap(c => c.devices);
  const context = planRoutingContext(page, zones, allDevices, [input.panel]);
  const { allowed, blocked } = context;
  const obstacles = [...context.obstacles, ...(input.extraObstacles || [])];
  // Devices or the panel inside an obstacle footprint must not be walled in.
  const obstacleBoxes = obstacles.map(o => o.box).filter(box => !pointIn(input.panel, box) && !allDevices.some(d => pointIn(d, box)));
  const router = new OrthoRouter({ width: W, height: H, segments: page.segments, obstacles: obstacleBoxes, allowed, blocked });

  const runs: PlannedRun[] = [];
  const codeRefs = new Set<string>();
  const ed = settings.necEdition;

  // 1. Branch circuitry per circuit: chain devices nearest-neighbour from the far end.
  const circuitLegs = new Map<string, { homeDevice: Pt; branchFt: number; farthestFt: number }>();
  for (const circuit of input.circuits) {
    if (!circuit.devices.length) continue;
    const order = chainDevices(circuit.devices, input.panel);
    let branchPts = 0;
    let farthest = 0;
    for (let i = 0; i + 1 < order.length; i += 1) {
      const leg = router.route(order[i], order[i + 1]);
      const len = pathLength(leg.path);
      branchPts += len;
      runs.push({
        id: `${circuit.id}-b${i + 1}`,
        kind: 'branch',
        circuitIds: [circuit.id],
        path: leg.path,
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
    farthest = branchPts;
    circuitLegs.set(circuit.id, { homeDevice: order[order.length - 1], branchFt: branchPts * input.ftPerPt, farthestFt: farthest * input.ftPerPt });
  }

  // 2. Group circuits into home-run conduits by direction from the panel.
  const groups = groupCircuits(input.circuits.filter(c => circuitLegs.has(c.id)), input.panel, settings);
  groups.forEach((group, index) => {
    const legs = group.map(c => circuitLegs.get(c.id) as { homeDevice: Pt; branchFt: number; farthestFt: number });
    // Home run starts at the group's device closest to the panel.
    const startLeg = legs.reduce((best, leg) => dist(leg.homeDevice, input.panel) < dist(best.homeDevice, input.panel) ? leg : best, legs[0]);
    const route = router.route(startLeg.homeDevice, input.panel);
    router.markUsed(route.path);
    const homeFt = pathLength(route.path) * input.ftPerPt;
    const bends = totalBendDegrees(route.path);
    const runWarnings: string[] = [];
    if (!route.ok) runWarnings.push('No clear path found — straight-line fallback; adjust by hand.');

    const isCable = settings.wiringMethod === 'MC';
    const ccc = group.reduce((sum, c) => sum + (c.phase === 3 ? 3 : 2), 0);
    const sizing = group.map((circuit, i) => {
      const vdLength = homeFt + legs[i].farthestFt + settings.verticalFt;
      return sizeCircuit(circuit, vdLength, isCable ? (circuit.phase === 3 ? 3 : 2) : ccc, {
        material: settings.material,
        vdTargetPct: settings.vdTargetPct,
        necEdition: ed,
      });
    });
    const vdLengthFt = Math.max(...group.map((_, i) => homeFt + legs[i].farthestFt + settings.verticalFt));
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
      `≈${Math.round(homeFt)} ft home run (${Math.round(vdLengthFt)} ft incl. branch + ${settings.verticalFt} ft vertical) · VD ${worstVd.toFixed(1)}%`,
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
      label: `HR${index + 1} ${shortCircuitList(group.map(c => c.label || c.id))}: ${label}`,
      note,
      conduit,
      sizing,
      vdLengthFt: round1(vdLengthFt),
      warnings: runWarnings,
    });
    warnings.push(...runWarnings.map(w => `HR${index + 1}: ${w}`));
  });

  // Offset parallel conduits so they read as separate runs.
  offsetParallelHomeRuns(runs.filter(r => r.kind === 'homerun'), Math.max(W, H) / 400);

  // Safety: no run may cross an obstacle footprint.
  for (const run of runs) {
    for (const ob of obstacles) {
      if (obstacleBoxes.includes(ob.box) && run.path.some((p, i) => i + 1 < run.path.length && segmentHitsBox(p, run.path[i + 1], shrink(ob.box, 2)))) {
        run.warnings.push(`Crosses ${ob.label} — reroute by hand.`);
      }
    }
  }
  if (!obstacles.length) warnings.push('No elevators, shafts or stairs were labeled on this view.');
  if (input.panelOffSheet) warnings.push(`Panel ${input.panelLabel} is on another sheet: home runs stop at the plan edge; add the remaining length from that sheet.`);
  return { runs, obstacles, ftPerPt: input.ftPerPt, scaleSource: input.scaleSource, warnings, codeRefs: [...codeRefs] };
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
