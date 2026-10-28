import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { zoneFromSignals, type ZonePageInput } from '../detection/pageZones';
import { sizeCircuit, sizeConduit } from './sizing';
import { sizeIndex } from './necTables';
import { detectProjectLocation, governingNec } from './jurisdiction';
import { OrthoRouter, segmentHitsBox } from './spatial';
import { DEFAULT_RUN_SETTINGS, findViewScale, parseScaleFtPerPt, planRuns } from './planRuns';
import { polylineLength, recomputeRunMarkup } from './overlay';
import { autoCircuit } from './suggestRunsTool';
import type { PolygonMarkup } from '@/types/markup';

const SETTINGS = { material: 'cu' as const, vdTargetPct: 3, necEdition: 2023 };

function loadFixture(name: string): ZonePageInput {
  const file = path.resolve(__dirname, '../../../test/fixtures/zones', `${name}.json.gz`);
  return JSON.parse(gunzipSync(readFileSync(file)).toString());
}

describe('circuit sizing', () => {
  it('20 A lighting circuit on a short run is #12 Cu with #12 EGC', () => {
    const s = sizeCircuit({ id: 'LP-1', loadVA: 1200, voltage: 120, phase: 1, continuous: true }, 60, 2, SETTINGS);
    expect(s.ocpdAmps).toBe(20);
    expect(s.conductor).toBe('12');
    expect(s.egc).toBe('12');
    expect(s.vdPct).toBeLessThanOrEqual(3);
  });

  it('long runs are upsized for voltage drop and the EGC is upsized proportionally', () => {
    const s = sizeCircuit({ id: 'LP-3', loadVA: 1900, voltage: 120, phase: 1, continuous: true }, 220, 2, SETTINGS);
    expect(s.ampacityConductor).toBe('12');
    expect(sizeIndex(s.conductor)).toBeGreaterThan(sizeIndex('12'));
    expect(s.vdPct).toBeLessThanOrEqual(3);
    expect(sizeIndex(s.egc)).toBeGreaterThan(sizeIndex('12'));
    expect(s.notes.join(' ')).toMatch(/voltage drop/i);
  });

  it('six #12 + #12 ground fits in 1/2" EMT; more wire steps the conduit up', () => {
    const small = sizeConduit([{ size: '12', count: 6, role: 'phase' }, { size: '12', count: 1, role: 'egc' }], 'EMT');
    expect(small.tradeSize).toBe('1/2');
    expect(small.fillPct).toBeLessThanOrEqual(40);
    const big = sizeConduit([{ size: '8', count: 9, role: 'phase' }, { size: '10', count: 1, role: 'egc' }], 'EMT');
    expect(['1', '1-1/4']).toContain(big.tradeSize);
  });
});

describe('code basis from the project address', () => {
  it('finds the project city/state from title-block text (most repeated wins)', () => {
    const loc = detectProjectLocation([
      { text: '123 MAIN STREET DANVILLE, IN 46122', page: 1 },
      { text: 'DANVILLE, IN 46122', page: 2 },
      { text: 'ARCHITECT: INDIANAPOLIS, IN 46204', page: 1 },
    ]);
    expect(loc?.state).toBe('IN');
    expect(loc?.city?.toUpperCase()).toBe('DANVILLE');
  });

  it('uses the state-adopted edition, honors effective dates, and flags local adoption', () => {
    expect(governingNec('TX').edition).toBe(2026);
    expect(governingNec('WA', new Date('2026-10-24')).edition).toBe(2023);
    expect(governingNec('WA', new Date('2027-01-15')).edition).toBe(2026);
    const mo = governingNec('MO');
    expect(mo.assumed).toBe(true);
    expect(mo.cautions.join(' ')).toMatch(/AHJ|local/i);
    expect(governingNec(undefined).assumed).toBe(true);
  });
});

describe('spatial routing', () => {
  it('routes around an elevator instead of over it', () => {
    const elevator = { x: 400, y: 200, width: 200, height: 400 };
    const router = new OrthoRouter({ width: 1000, height: 800, obstacles: [elevator], clearance: 10 });
    const route = router.route({ x: 100, y: 400 }, { x: 900, y: 400 });
    expect(route.ok).toBe(true);
    for (let i = 0; i + 1 < route.path.length; i += 1) {
      expect(segmentHitsBox(route.path[i], route.path[i + 1], elevator)).toBe(false);
    }
    expect(route.bends).toBeGreaterThanOrEqual(2);
  });

  it('parses architectural and engineering scales', () => {
    expect(parseScaleFtPerPt('SCALE: 1/8" = 1\'-0"')).toBeCloseTo(1 / 9, 5);
    expect(parseScaleFtPerPt('1" = 20\'')).toBeCloseTo(20 / 72, 5);
  });
});

describe('suggested runs on a real sheet (Otsego E210)', () => {
  const page = loadFixture('otsego_E210');
  const zones = zoneFromSignals(page);
  const W = page.pageWidth;
  const H = page.pageHeight;
  const tags = page.textItems.filter(t => /^LP-\d+$/.test(t.str.trim()) && t.y / H > 0.5);
  const byCircuit = new Map<string, Array<{ x: number; y: number }>>();
  for (const t of tags) {
    const k = t.str.trim();
    byCircuit.set(k, [...(byCircuit.get(k) || []), { x: t.x + t.width / 2, y: t.y - 10 }]);
  }
  const circuits = [...byCircuit.entries()].map(([id, devices]) => ({
    id, label: id, devices, loadVA: devices.length * 150, voltage: 120, phase: 1 as const, continuous: true,
  }));

  it('builds bundled, sized home runs that stay inside the plan view', () => {
    expect(circuits.length).toBeGreaterThan(1);
    const scale = findViewScale(page, zones, circuits.flatMap(c => c.devices));
    expect(scale).not.toBeNull();
    const plan = planRuns({
      page, zones, panel: { x: 0.83 * W, y: 0.52 * H }, panelLabel: 'LP', circuits,
      settings: DEFAULT_RUN_SETTINGS, ftPerPt: scale!.ftPerPt, scaleSource: scale!.text,
    });
    const homeRuns = plan.runs.filter(r => r.kind === 'homerun');
    expect(homeRuns.length).toBeGreaterThan(0);
    const bundled = new Set(homeRuns.flatMap(r => r.circuitIds));
    expect(bundled.size).toBe(circuits.length);
    for (const run of homeRuns) {
      expect(run.circuitIds.length).toBeLessThanOrEqual(DEFAULT_RUN_SETTINGS.maxCircuitsPerConduit);
      expect(run.label).toMatch(/EMT/);
      expect(Math.max(...run.sizing.map(s => s.vdPct))).toBeLessThanOrEqual(DEFAULT_RUN_SETTINGS.vdTargetPct);
    }
    const excluded = zones.filter(z => ['schedule', 'notes', 'title_block'].includes(z.kind));
    for (const run of plan.runs) {
      for (const p of run.path) {
        const px = (p.x / W) * 100;
        const py = (p.y / H) * 100;
        const inside = excluded.some(z => px > z.bounds.x + 0.5 && py > z.bounds.y + 0.5
          && px < z.bounds.x + z.bounds.width - 0.5 && py < z.bounds.y + z.bounds.height - 0.5);
        expect(inside, `${run.id} point in ${px.toFixed(1)},${py.toFixed(1)}`).toBe(false);
      }
    }
  });

  it('never draws a branch arc through a keep-clear box the user marked', () => {
    const scale = findViewScale(page, zones, circuits.flatMap(c => c.devices))!;
    const base = { page, zones, panel: { x: 0.83 * W, y: 0.52 * H }, panelLabel: 'LP', circuits, settings: DEFAULT_RUN_SETTINGS, ftPerPt: scale.ftPerPt, scaleSource: scale.text };
    const first = planRuns(base);
    const withArc = first.runs.find(r => r.kind === 'branch' && r.arc && Math.hypot(r.arc[2].x - r.arc[0].x, r.arc[2].y - r.arc[0].y) > 40)!;
    expect(withArc).toBeTruthy();
    // A box right on the arc's bulge, clear of both fixtures.
    const [a, mid, b] = withArc.arc!;
    const size = Math.hypot(b.x - a.x, b.y - a.y) * 0.15;
    const box = { x: mid.x - size / 2, y: mid.y - size / 2, width: size, height: size };
    const sample = (arc: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }]) => {
      const [p0, m, p2] = arc;
      const c = { x: 2 * m.x - (p0.x + p2.x) / 2, y: 2 * m.y - (p0.y + p2.y) / 2 };
      return Array.from({ length: 33 }, (_, i) => {
        const t = i / 32;
        return { x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * c.x + t * t * p2.x, y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * c.y + t * t * p2.y };
      });
    };
    const inBox = (p: { x: number; y: number }) => p.x > box.x + 1 && p.x < box.x + box.width - 1 && p.y > box.y + 1 && p.y < box.y + box.height - 1;
    expect(sample(withArc.arc!).some(inBox)).toBe(true);
    const second = planRuns({ ...base, extraObstacles: [{ kind: 'opening', label: 'Keep clear 1', box }], keepClearConfirmed: true });
    for (const run of second.runs.filter(r => r.kind === 'branch' && r.arc)) {
      expect(sample(run.arc!).some(inBox), run.id).toBe(false);
    }
  });

  it('routes every circuit it can and lists (never draws) one that is walled in', () => {
    const scale = findViewScale(page, zones, circuits.flatMap(c => c.devices))!;
    // A fixture boxed in on all four sides by the user's keep-clear zones (none covers it).
    const target = circuits.find(c => c.devices.length >= 3)!;
    const d = target.devices[0];
    const t = 3; const r = 10;
    const ring = [
      { x: d.x - r, y: d.y - r, width: 2 * r, height: t },
      { x: d.x - r, y: d.y + r - t, width: 2 * r, height: t },
      { x: d.x - r, y: d.y - r, width: t, height: 2 * r },
      { x: d.x + r - t, y: d.y - r, width: t, height: 2 * r },
    ].map((box, i) => ({ kind: 'opening' as const, label: `Keep clear ${i + 1}`, box }));
    const near = (p: { x: number; y: number }) => Math.abs(p.x - d.x) <= r + 10 && Math.abs(p.y - d.y) <= r + 10;
    // Its circuit has fixtures outside the ring: the string can't reach them.
    const trapped = { ...target, devices: [d, ...target.devices.slice(1).filter(p => !near(p))] };
    expect(trapped.devices.length).toBeGreaterThan(1);
    const others = circuits.filter(c => c !== target).map(c => ({ ...c, devices: c.devices.filter(p => !near(p)) })).filter(c => c.devices.length);
    const plan = planRuns({
      page, zones, panel: { x: 0.83 * W, y: 0.65 * H }, panelLabel: 'LP', circuits: [trapped, ...others],
      settings: DEFAULT_RUN_SETTINGS, ftPerPt: scale.ftPerPt, scaleSource: scale.text, extraObstacles: ring, keepClearConfirmed: true,
    });
    expect(plan.blockedCircuits).toEqual([trapped.id]);
    expect(plan.runs.some(run => run.circuitIds.includes(trapped.id))).toBe(false);
    expect(plan.runs.filter(run => run.kind === 'homerun').length).toBeGreaterThan(0);
    expect(plan.warnings.some(w => w.startsWith('Not routed') && w.includes(trapped.id))).toBe(true);
  });

  it('auto-groups devices by printed circuit tags', () => {
    const devices = circuits.flatMap(c => c.devices.map(d => ({ x: d.x, y: d.y + 4 })));
    const grouped = autoCircuit(devices, page, {
      vaPerDevice: 150, voltage: 120, phase: 1, continuous: true, breakerAmps: 20, useCircuitTags: true,
    });
    const ids = new Set(grouped.map(c => c.id));
    for (const id of byCircuit.keys()) expect(ids.has(id)).toBe(true);
  });
});

describe('editable run overlay', () => {
  const base: PolygonMarkup = {
    id: 'run_1', type: 'polyline', page: 1, locked: false, author: 'BidveraAi', createdAt: '',
    style: { strokeColor: '#e11d48', fillColor: 'transparent', strokeWidth: 3, opacity: 1, fontSize: 10, fontFamily: 'Inter' },
    points: [{ x: 0, y: 0 }, { x: 360, y: 0 }],
    label: 'HR1: old',
    aiRun: {
      runId: 'HR1', kind: 'homerun', ftPerPt: 1 / 9, lengthFt: 40,
      circuits: [{ id: 'LP-1', loadVA: 900, voltage: 120, phase: 1, continuous: false, branchFt: 20 }],
      settings: { wiringMethod: 'EMT', material: 'cu', vdTargetPct: 3, verticalFt: 15, necEdition: 2023 },
    },
  };

  it('recomputes length, sizes and VD after a point is dragged', () => {
    const short = recomputeRunMarkup(base)!;
    expect(short.aiRun.lengthFt).toBeCloseTo(40, 0);
    expect(short.label).toMatch(/^HR1: 1\/2" EMT – .*#12/);
    const dragged = { ...base, points: [{ x: 0, y: 0 }, { x: 1800, y: 0 }, { x: 1800, y: 900 }] };
    expect(polylineLength(dragged.points) / 9).toBeCloseTo(300, 0);
    const long = recomputeRunMarkup(dragged)!;
    expect(long.aiRun.lengthFt).toBeCloseTo(300, 0);
    expect(long.label).not.toMatch(/#12(?!G)/);
    expect(long.aiRun.vdPct!).toBeLessThanOrEqual(3);
    expect(long.aiNote).toMatch(/VD/);
  });

  it('ignores non-run markups', () => {
    const { aiRun: _ignored, ...plain } = base;
    expect(recomputeRunMarkup(plain as PolygonMarkup)).toBeNull();
  });
});
