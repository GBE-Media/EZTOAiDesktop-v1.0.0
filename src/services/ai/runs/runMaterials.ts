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

export function assemblyProductSpec(assembly: RunAssembly, kind: 'homerun' | 'branch'): TakeoffProductSpec {
  return {
    key: assembly.key,
    name: assembly.name,
    folder: kind === 'homerun' ? 'Home Runs' : 'Branch Circuits',
    unit: 'ft',
    description: `Per foot: ${assembly.materials.map(m => `${m.perFt} ft ${m.name}`).join(', ')}`,
    components: assembly.materials.map((m, i) => ({
      name: m.name,
      quantity: m.perFt,
      unit: 'ft',
      componentType: 'product' as const,
      sortOrder: i,
    })),
  };
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
