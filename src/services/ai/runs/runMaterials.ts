/**
 * Material breakdown for suggested runs: what each foot of a home run / branch is made of
 * (raceway + conductors, or MC cable), and project totals by size.
 */
import { formatSize, type ConductorSize, type RacewayType } from './necTables';
import { formatTradeSize, type CircuitSizing, type ConduitSizing } from './sizing';
import type { PlannedRun, RunSettings } from './planRuns';
import type { TakeoffProductSpec } from '../catalog/takeoffProducts';

export interface RunMaterial {
  name: string;
  unit: 'ft';
  /** Quantity per foot of run. */
  perFt: number;
}

export interface RunAssembly {
  key: string;
  name: string;
  materials: RunMaterial[];
}

function wireName(size: ConductorSize, material: 'cu' | 'al'): string {
  return `${formatSize(size)} THHN ${material === 'al' ? 'Al' : 'Cu'}`;
}

function mcName(sizing: CircuitSizing): string {
  return `MC Cable ${formatSize(sizing.conductor).replace('#', '')}/${sizing.ccc}+G`;
}

/** Branch circuits use the minimum raceway (1/2") with the circuit's conductors. */
const BRANCH_TRADE_SIZE = '1/2';

export function runAssembly(run: PlannedRun, settings: RunSettings, circuitSizing?: CircuitSizing): RunAssembly | null {
  if (settings.wiringMethod === 'MC') {
    const rows = run.kind === 'homerun' ? run.sizing : circuitSizing ? [circuitSizing] : [];
    if (!rows.length) return null;
    const counts = new Map<string, number>();
    for (const s of rows) counts.set(mcName(s), (counts.get(mcName(s)) || 0) + 1);
    const materials = [...counts.entries()].map(([name, n]) => ({ name, unit: 'ft' as const, perFt: n }));
    const name = materials.map(m => (m.perFt > 1 ? `${m.perFt}× ${m.name}` : m.name)).join(' + ');
    return { key: `run:${name}`, name, materials };
  }
  const raceway = settings.wiringMethod as RacewayType;
  let conductors: ConduitSizing['conductors'];
  let trade: string;
  if (run.kind === 'homerun' && run.conduit) {
    conductors = run.conduit.conductors;
    trade = run.conduit.tradeSize;
  } else if (circuitSizing) {
    const hots = circuitSizing.ccc;
    conductors = [
      { size: circuitSizing.conductor, count: hots, role: 'phase' },
      { size: circuitSizing.egc, count: 1, role: 'egc' },
    ];
    trade = BRANCH_TRADE_SIZE;
  } else {
    return null;
  }
  const raceName = formatTradeSize(trade as never, raceway);
  const wires = new Map<string, number>();
  for (const row of conductors) {
    if (row.count <= 0) continue;
    const name = wireName(row.size, settings.material);
    wires.set(name, (wires.get(name) || 0) + row.count);
  }
  const materials: RunMaterial[] = [
    { name: raceName, unit: 'ft', perFt: 1 },
    ...[...wires.entries()].map(([name, n]) => ({ name, unit: 'ft' as const, perFt: n })),
  ];
  const wireText = [...wires.entries()].map(([name, n]) => `${n}${name.split(' ')[0]}`).join(', ');
  const name = `${raceName} w/ ${wireText}`;
  return { key: `run:${name}`, name, materials };
}

/**
 * MC runs that carry a single cable type are taken off as that cable (feet of cable), so
 * "2× MC Cable 12/2+G" over 100 ft is 200 ft of the "MC Cable 12/2+G" product — the same
 * number the material table reports.
 */
export function singleCable(assembly: Pick<RunAssembly, 'materials'> | null | undefined): { name: string; perFt: number } | null {
  if (!assembly || assembly.materials.length !== 1) return null;
  const only = assembly.materials[0];
  return /^MC Cable /.test(only.name) ? { name: only.name, perFt: only.perFt } : null;
}

/** Feet of the run's primary product (the conduit, or the first cable × cables in the bundle). */
export function runProductFeet(assembly: Pick<RunAssembly, 'materials'> | null | undefined, lengthFt: number): number {
  const first = assembly?.materials[0];
  return Math.round(lengthFt * (first ? first.perFt : 1) * 10) / 10;
}

const CONDUIT_LABELS: Record<string, string> = { PVC: 'PVC Sch 40 Conduit', EMT: 'EMT Conduit', RMC: 'Rigid Conduit (RMC)', IMC: 'IMC Conduit' };

/** Product tree folder + display name for one run material. */
export function materialProductSpec(name: string): TakeoffProductSpec {
  if (/^MC Cable /.test(name)) {
    return {
      key: `run:${name}`,
      name,
      folder: 'MC Cable',
      unit: 'ft',
      description: `${name}, feet of cable (home runs count each cable in the bundle)`,
    };
  }
  if (/THHN|THWN|XHHW|^#\d|\bAWG\b|kcmil/i.test(name)) {
    return { key: `wire:${name}`, name, folder: 'Wire', unit: 'ft', description: `${name}, feet of conductor (run feet × conductors)` };
  }
  const conduit = /^(\S+")\s*(PVC|EMT|RMC|IMC)$/.exec(name.trim());
  const display = conduit ? `${conduit[1]} ${CONDUIT_LABELS[conduit[2]] || conduit[2]}` : name;
  return { key: `conduit:${name}`, name: display, folder: 'Conduit', unit: 'ft', description: `${display}, feet of raceway` };
}

/**
 * Products a run is taken off as: the conduit (or cable) is the run's own product; the wire
 * pulled in a conduit is listed and counted separately (feet = run feet × conductors). The
 * drawing still shows one run.
 */
export function runMaterialProducts(assembly: Pick<RunAssembly, 'materials'>): Array<{ spec: TakeoffProductSpec; perFt: number }> {
  return assembly.materials.map(m => ({ spec: materialProductSpec(m.name), perFt: m.perFt }));
}

/** The run's primary product (conduit / cable). */
export function assemblyProductSpec(assembly: RunAssembly, _kind?: 'homerun' | 'branch'): TakeoffProductSpec {
  void _kind;
  return runMaterialProducts(assembly)[0]?.spec || materialProductSpec(assembly.name);
}

/** Totals by material across runs (feet, rounded up). */
export function materialTotals(rows: Array<{ assembly: RunAssembly | null; lengthFt: number }>): Array<{ name: string; ft: number }> {
  const totals = new Map<string, number>();
  for (const { assembly, lengthFt } of rows) {
    if (!assembly) continue;
    for (const m of assembly.materials) totals.set(m.name, (totals.get(m.name) || 0) + m.perFt * lengthFt);
  }
  return [...totals.entries()]
    .map(([name, ft]) => ({ name, ft: Math.ceil(ft) }))
    .sort((a, b) => b.ft - a.ft);
}
