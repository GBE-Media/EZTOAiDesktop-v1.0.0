import { describe, expect, it } from 'vitest';
import { useProductStore } from '@/store/productStore';
import { circuitsFromTags, panelNamesFromSchedules, parseCircuitTag, suggestPanels } from './circuitTags';
import { materialTotals, runAssembly } from './runMaterials';
import { DEFAULT_RUN_SETTINGS, shortCircuitList, type PlannedRun } from './planRuns';
import { ensureTakeoffProduct, fixtureProductSpec } from '../catalog/takeoffProducts';
import { bindTakeoffProducts } from '../catalog/bindTakeoffProducts';
import { buildMeasurementFromMarkup } from '../catalog/measurementFromMarkup';
import type { CanvasMarkup } from '@/types/markup';

const page = (items: Array<{ str: string; x: number; y: number }>) => ({
  pageWidth: 1000,
  pageHeight: 800,
  textItems: items.map(i => ({ ...i, width: 20, height: 8 })),
}) as never;

describe('circuit tags', () => {
  it('parses engineer panel-circuit tags, including after the fixture type', () => {
    expect(parseCircuitTag('B-4')).toEqual({ panel: 'B', circuit: '4', id: 'B-4' });
    expect(parseCircuitTag('A B-4')?.id).toBe('B-4');
    expect(parseCircuitTag('XA B-4')?.id).toBe('B-4');
    expect(parseCircuitTag('LP1-12,14')?.id).toBe('LP1-12,14');
    expect(parseCircuitTag('HELLO')).toBeNull();
  });

  it('groups devices by their nearest tag, one circuit per tag', () => {
    const p = page([{ str: 'B-4', x: 100, y: 100 }, { str: 'B-6', x: 500, y: 100 }, { str: 'S-1', x: 800, y: 100 }]);
    const out = circuitsFromTags(
      [{ point: { x: 112, y: 112 }, itemId: 'a' }, { point: { x: 505, y: 110 }, itemId: 'b' }, { point: { x: 812, y: 105 }, itemId: 'c' }],
      p,
      { vaPerDevice: 100, voltage: 120, phase: 1, continuous: true },
    );
    expect(out.circuits.map(c => c.id).sort()).toEqual(['B-4', 'B-6']);
    expect(out.circuits.every(c => c.panel === 'B')).toBe(true);
    expect(out.untagged.map(d => d.itemId)).toEqual(['c']);
  });

  it('reads panel names from schedules without turning "PANELS" into panel S', () => {
    const names = panelNamesFromSchedules(['ALL PANELS SHALL BE BOLTED', 'PANEL B SCHEDULE', 'PANELBOARD: B', 'PANEL LP-1']);
    expect(names).toEqual(['B', 'LP-1']);
    expect(suggestPanels(['B', 'C'], names)).toEqual([
      { name: 'B', source: 'tags+schedule' },
      { name: 'C', source: 'tags' },
      { name: 'LP-1', source: 'schedule' },
    ]);
    expect(shortCircuitList(['B-4', 'B-6', 'B-8'])).toBe('B-4,6,8');
  });
});

describe('run materials and products', () => {
  const homeRun = {
    id: 'HR1', kind: 'homerun', circuitIds: ['B-4'], path: [], lengthFt: 100, bendsDeg: 0, wallCrossings: 0,
    sizing: [{ circuitId: 'B-4', conductor: '12', egc: '12', ccc: 2, vdPct: 1 }],
    conduit: { tradeSize: '3/4', conductors: [{ size: '12', count: 2, role: 'phase' }, { size: '12', count: 1, role: 'egc' }] },
    label: 'HR1', note: '',
  } as unknown as PlannedRun;

  it('breaks a run into conduit + wire per foot and totals the footage', () => {
    const assembly = runAssembly(homeRun, { ...DEFAULT_RUN_SETTINGS, wiringMethod: 'EMT' })!;
    expect(assembly.materials[0]).toMatchObject({ perFt: 1 });
    expect(assembly.materials.find(m => /THHN/.test(m.name))?.perFt).toBe(3);
    const totals = materialTotals([{ assembly, lengthFt: 100 }, { assembly, lengthFt: 50.2 }]);
    expect(totals.find(t => /THHN/.test(t.name))?.ft).toBe(451);
  });

  it('creates a takeoff product once and reuses it by key and by name', () => {
    const first = ensureTakeoffProduct(fixtureProductSpec('ZQ', 'Test troffer'));
    expect(first.created).toBe(true);
    expect(ensureTakeoffProduct(fixtureProductSpec('ZQ', 'Other text')).productId).toBe(first.productId);
    const own = useProductStore.getState().addProduct(null, 'Type ZR');
    expect(ensureTakeoffProduct(fixtureProductSpec('ZR', 'Downlight'))).toEqual({ productId: own, created: false });
    expect(useProductStore.getState().nodes[first.productId].unitOfMeasure).toBe('ea');
  });

  it('links counted fixtures and runs to products, and measures runs in feet', () => {
    const assembly = runAssembly(homeRun, { ...DEFAULT_RUN_SETTINGS, wiringMethod: 'EMT' })!;
    const count = { id: 'm1', type: 'count-marker', page: 1, label: 'ZQ' } as unknown as CanvasMarkup;
    const review = { id: 'm2', type: 'count-marker', page: 1, label: '?', reviewMarker: true } as unknown as CanvasMarkup;
    const run = {
      id: 'r1', type: 'polyline', page: 1, points: [],
      aiRun: { runId: 'HR1', kind: 'homerun', ftPerPt: 1, lengthFt: 42.25, assembly },
    } as unknown as CanvasMarkup;
    const bound = bindTakeoffProducts([{ page: 1, markup: count }, { page: 1, markup: review }, { page: 1, markup: run }]);
    expect(bound).toHaveLength(2);
    expect((count as { productId?: string }).productId).toBeTruthy();
    expect((review as { productId?: string }).productId).toBeUndefined();
    expect(bound.find(b => b.unit === 'ft')?.ft).toBe(42.3);
    expect(buildMeasurementFromMarkup(run, 'doc')).toMatchObject({ type: 'length', value: 42.3, unit: 'ft' });
  });
});
