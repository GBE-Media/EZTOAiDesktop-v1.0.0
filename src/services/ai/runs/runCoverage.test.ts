import { describe, expect, it } from 'vitest';
import { auditRunCoverage } from './runCoverage';
import { DEFAULT_RUN_SETTINGS, planRuns, type PlannedCircuit, type PlannedRun } from './planRuns';
import type { Pt } from './spatial';
import type { ZonePageInput } from '../detection/pageZones';

const a = { x: 100, y: 100 };
const b = { x: 200, y: 100 };
const panel = { x: 800, y: 100 };
const circuit = (id: string, devices: Pt[]): PlannedCircuit => ({ id, devices, loadVA: devices.length * 100, voltage: 120, phase: 1, continuous: true });
const run = (id: string, kind: 'branch' | 'homerun', from: Pt, to: Pt, circuitIds = ['A-1']): PlannedRun & { panelLabel: string } => ({
  id, kind, circuitIds, path: [from, to], fromPt: from, ...(kind === 'branch' ? { toPt: to } : {}),
  lengthFt: 10, bendsDeg: 0, wallCrossings: 0, label: '', note: '', sizing: [], vdLengthFt: 0, warnings: [], panelLabel: 'A',
});
const targets = [{ id: 'count-a', markerId: 'count-a', point: a }, { id: 'count-b', markerId: 'count-b', point: b }];
const panels = [{ label: 'A', point: panel }];

describe('per-count connectivity audit', () => {
  it('requires a continuous branch to a home run ending at the actual destination', () => {
    const circuits = [circuit('A-1', [a, b])];
    const runs = [run('branch', 'branch', a, b), run('home', 'homerun', b, panel)];
    expect(auditRunCoverage(targets, circuits, runs, panels)).toMatchObject({ total: 2, connected: 2, unresolved: 0, complete: true });
    expect(auditRunCoverage(targets, circuits, runs.slice(0, 1), panels).connected).toBe(0);
    expect(auditRunCoverage(targets, circuits, runs, [{ label: 'A', point: { x: 810, y: 100 } }]).connected).toBe(0);
  });

  it('a circuit ID on a shared home run is not a physical connection', () => {
    const circuits = [circuit('A-1', [a]), circuit('A-2', [b])];
    const home = run('home', 'homerun', a, panel, ['A-1', 'A-2']);
    expect(auditRunCoverage(targets, circuits, [home], panels)).toMatchObject({ connected: 1, unresolved: 1, complete: false });
    const collector = run('collector', 'branch', b, a, ['A-2']);
    expect(auditRunCoverage(targets, circuits, [home, collector], panels).complete).toBe(true);
  });

  it('does not count a passing line or a detached endpoint as connected', () => {
    const circuits = [circuit('A-1', [a, b])];
    const home = run('home', 'homerun', a, panel);
    expect(auditRunCoverage(targets, circuits, [home], panels).connected).toBe(1);
    home.path[0] = { x: a.x + 1, y: a.y };
    expect(auditRunCoverage(targets, circuits, [home], panels).connected).toBe(0);
  });

  it('accounts for blocked, unassigned, conflicting and unlocated counts without dropping IDs', () => {
    const input = [...targets, { id: 'missing' }, { id: 'other', point: { x: 600, y: 600 } }];
    const result = auditRunCoverage(input, [circuit('A-1', [a, b]), circuit('A-2', [b])], [], panels, ['A-1']);
    expect(result).toMatchObject({ total: 4, connected: 0, unresolved: 4, complete: false });
    expect(result.fixtures.map(f => f.status)).toEqual(['blocked', 'conflict', 'missing_location', 'unassigned']);
  });

  it('keeps separate marker identities at the same location', () => {
    const result = auditRunCoverage([{ id: 'one', point: a }, { id: 'two', point: a }],
      [circuit('A-1', [a])], [run('home', 'homerun', a, panel)], panels);
    expect(result).toMatchObject({ total: 2, connected: 2, complete: true });
  });
});

describe('shared home-run collectors', () => {
  const page = { pageWidth: 1000, pageHeight: 800, textItems: [], segments: [] } as unknown as ZonePageInput;
  it('draws and measures a collector for each circuit sharing a home run', () => {
    const circuits = [circuit('A-1', [{ x: 100, y: 100 }]), circuit('A-2', [{ x: 200, y: 120 }])];
    const result = planRuns({ page, zones: [], panel, panelLabel: 'A', circuits, settings: DEFAULT_RUN_SETTINGS, ftPerPt: 0.1, scaleSource: 'test' });
    expect(result.runs.filter(r => r.kind === 'homerun')).toHaveLength(1);
    const collector = result.runs.find(r => r.id.endsWith('-collector'))!;
    expect(collector).toBeDefined();
    expect(collector.lengthFt).toBeGreaterThan(0);
    expect(result.loadCenterFt?.[collector.circuitIds[0]]).toBeCloseTo(collector.lengthFt, 1);
    const coverage = auditRunCoverage(circuits.flatMap(c => c.devices.map((point, i) => ({ id: `${c.id}-${i}`, point }))),
      circuits, result.runs.map(r => ({ ...r, panelLabel: 'A' })), panels);
    expect(coverage.complete).toBe(true);
  });
});
