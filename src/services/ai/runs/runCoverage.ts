import type { PlannedCircuit, PlannedRun } from './planRuns';
import type { Pt } from './spatial';

/** Stable marker IDs remain the accounting identity, even when analysis IDs change. */
export interface RunTarget {
  id: string;
  itemId?: string;
  markerId?: string;
  point?: Pt;
}

export interface RunCoverage {
  total: number;
  connected: number;
  unresolved: number;
  complete: boolean;
  fixtures: Array<RunTarget & {
    circuitIds: string[];
    runIds: string[];
    status: 'connected' | 'unassigned' | 'blocked' | 'disconnected' | 'conflict' | 'missing_location';
    reason?: string;
  }>;
}

// Endpoint equality, not proximity: passing near a count never constitutes a connection.
const key = (p: Pt) => `${p.x.toFixed(4)}:${p.y.toFixed(4)}`;
const same = (a: Pt | undefined, b: Pt | undefined) => !!a && !!b && key(a) === key(b);

export function auditRunCoverage(
  targets: RunTarget[],
  circuits: PlannedCircuit[],
  runs: Array<PlannedRun & { panelLabel?: string }>,
  panels: Array<{ label: string; point: Pt }>,
  blockedCircuits: string[] = [],
): RunCoverage {
  const blocked = new Set(blockedCircuits);
  const reachable = new Map<string, Set<string>>();
  for (const circuit of circuits) {
    const edges = new Map<string, Set<string>>();
    const roots = new Set<string>();
    for (const run of runs.filter(r => r.circuitIds.includes(circuit.id))) {
      const drawn = run.arc || run.path;
      const a = drawn[0];
      const b = drawn[drawn.length - 1];
      if (drawn.length < 2 || !same(a, run.fromPt)) continue;
      if (run.kind === 'homerun') {
        if (panels.some(p => p.label === run.panelLabel && same(b, p.point))) roots.add(key(a));
      } else if (same(b, run.toPt)) {
        const ak = key(a); const bk = key(b);
        edges.set(ak, new Set([...(edges.get(ak) || []), bk]));
        edges.set(bk, new Set([...(edges.get(bk) || []), ak]));
      }
    }
    const queue = [...roots];
    for (let i = 0; i < queue.length; i += 1) {
      for (const next of edges.get(queue[i]) || []) {
        if (!roots.has(next)) { roots.add(next); queue.push(next); }
      }
    }
    reachable.set(circuit.id, roots);
  }
  const fixtures: RunCoverage['fixtures'] = targets.map(target => {
    const circuitIds = target.point
      ? circuits.filter(c => c.devices.some(p => same(p, target.point))).map(c => c.id) : [];
    const runIds = runs.filter(r => r.circuitIds.some(id => circuitIds.includes(id))
      && (same(r.fromPt, target.point) || same(r.toPt, target.point))).map(r => r.id);
    const row = { ...target, circuitIds, runIds };
    if (!target.point) return { ...row, status: 'missing_location', reason: 'Count has no valid drawing location.' };
    if (!circuitIds.length) return { ...row, status: 'unassigned', reason: 'No circuit assigned to this count.' };
    if (circuitIds.length > 1) return { ...row, status: 'conflict', reason: 'Count is assigned to more than one circuit; confirm its circuit.' };
    const id = circuitIds[0];
    if (blocked.has(id)) return { ...row, status: 'blocked', reason: 'No safe route to the destination without crossing a blocked area or leaving the building.' };
    if (!reachable.get(id)?.has(key(target.point))) {
      return { ...row, status: 'disconnected', reason: 'No continuous drawn connection from this count to its panel or continuation point.' };
    }
    return { ...row, status: 'connected' };
  });
  const connected = fixtures.filter(f => f.status === 'connected').length;
  return { total: fixtures.length, connected, unresolved: fixtures.length - connected, complete: connected === fixtures.length, fixtures };
}
