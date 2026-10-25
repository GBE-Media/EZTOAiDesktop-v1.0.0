import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZonePageInput } from '../detection/pageZones';

const fixture: ZonePageInput & { rotate: number } = JSON.parse(gunzipSync(readFileSync(
  path.resolve(__dirname, '../../../test/fixtures/zones/otsego_E210.json.gz'),
)).toString());

vi.mock('../detection/pageZones', async importOriginal => {
  const actual = await importOriginal<typeof import('../detection/pageZones')>();
  return {
    ...actual,
    extractZoneInputs: vi.fn(async () => fixture),
    ensurePageZones: vi.fn(async () => actual.zoneFromSignals(fixture)),
  };
});

const analysisItems: Array<{ id: string; location: { x: number; y: number } }> = [];
vi.mock('../agent/pageAnalysisCache', () => ({
  getLatestFullPageAnalysis: vi.fn(() => ({ analysis: { items: analysisItems } })),
}));

import { useCanvasStore } from '@/store/canvasStore';
import { getAssistantTool } from '../tools/registry';
import { createSuggestRunsTool, panelNameCandidates, prepareRunPlan, specWiringMethod, type RunInputNeeded } from './suggestRunsTool';
import { applyFieldAnswers } from '../agent/askUser';
import { createPageGeometry, docToRender } from '../placement/coords';
import type { PolygonMarkup } from '@/types/markup';

const DOC = 'doc_otsego';
const W = fixture.pageWidth;
const H = fixture.pageHeight;

function circuitsFromTags() {
  const tags = fixture.textItems.filter(t => /^LP-\d+$/.test(t.str.trim()) && t.y / H > 0.5);
  const byCircuit = new Map<string, string[]>();
  analysisItems.length = 0;
  tags.forEach((t, i) => {
    const id = `item_${i}`;
    analysisItems.push({ id, location: { x: ((t.x + t.width / 2) / W) * 100, y: ((t.y - 10) / H) * 100 } });
    byCircuit.set(t.str.trim(), [...(byCircuit.get(t.str.trim()) || []), id]);
  });
  return [...byCircuit.entries()].map(([id, itemIds]) => ({ id, itemIds, vaPerDevice: 150, voltage: 120, phase: 1 as const }));
}

beforeEach(() => {
  useCanvasStore.setState(state => ({
    ...state,
    activeDocId: DOC,
    pdfDocuments: {
      [DOC]: {
        pdfDocument: { getPage: async () => ({ view: [0, 0, H, W], rotate: 90 }) },
        totalPages: 10,
        currentPage: 4,
        originalPageWidth: H,
        originalPageHeight: W,
        contentRevision: 0,
      },
    } as never,
    pageCalibrationsByDoc: {},
  }));
});

describe('suggest_runs tool', () => {
  it('asks for the panel location when the label is not on the sheet', async () => {
    const result = await prepareRunPlan({ page: 4, panel: { label: 'ZZQ-9' }, circuits: circuitsFromTags(), settings: { wiringMethod: 'EMT' } } as never);
    expect('needs' in result && result.needs).toBe('input');
    expect((result as RunInputNeeded).missing).toEqual(['panel_location']);
  });

  it('pauses with one card for panel + wiring method, and the answers rebuild the exact call', async () => {
    const tool = createSuggestRunsTool();
    const circuits = circuitsFromTags();
    const out = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval: vi.fn() } as never, { page: 4, circuits } as never);
    expect(out.status).toBe('completed');
    const ask = out.askUser!;
    expect(ask.fields.map(f => f.id)).toEqual(['panel_label', 'panel_location', 'wiring_method']);
    const point = ask.fields.find(f => f.id === 'panel_location')!;
    expect(point.kind).toBe('point');
    expect(point.page).toBe(4);
    expect(ask.fields.find(f => f.id === 'wiring_method')!.options!.map(o => o.value)).toEqual(['EMT', 'MC', 'PVC40', 'RMC']);
    const args = applyFieldAnswers(ask.resume!.args, ask.resume!.apply, {
      panel_label: { value: 'LP' },
      panel_location: { point: { documentId: DOC, page: 4, xPct: 83, yPct: 52 } },
      wiring_method: { value: 'MC', label: 'MC cable' },
    });
    expect(args).toMatchObject({ page: 4, documentId: DOC, panel: { label: 'LP', x: 83, y: 52 }, settings: { wiringMethod: 'MC' } });
    const addApproval = vi.fn();
    const again = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval } as never, args as never);
    expect(again.status).toBe('approval-required');
    expect(again.askUser).toBeUndefined();
  });

  it('reads panel names and the wiring method from the specs', () => {
    expect(panelNameCandidates(['PANEL LP-1 SCHEDULE', 'PANEL: LP-1', 'PANELBOARD H1', 'PANEL SCHEDULE'])).toEqual(['LP-1', 'H1']);
    expect(specWiringMethod(['3.1 WIRING METHODS: BRANCH CIRCUITS SHALL BE TYPE MC CABLE', 'NOTES'])).toBe('MC');
    expect(specWiringMethod(['NO RELEVANT TEXT'])).toBeUndefined();
  });

  it('produces doc-coordinate run markups on a rotated sheet that land on the devices', async () => {
    const circuits = circuitsFromTags();
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 52 }, circuits, settings: { wiringMethod: 'EMT' } } as never);
    if ('needs' in result) throw new Error(result.message);
    const runs = result.markups.map(r => r.markup).filter(m => m.type === 'polyline') as PolygonMarkup[];
    const homeRuns = runs.filter(m => m.aiRun?.kind === 'homerun');
    expect(homeRuns.length).toBeGreaterThan(0);
    expect(homeRuns.every(m => /EMT/.test(m.label || ''))).toBe(true);
    // Every run point maps back inside the displayed page (rotation applied correctly).
    const geometry = createPageGeometry({ pageNumber: 4, docWidth: H, docHeight: W, rotationDeg: 90, renderScale: 1 });
    for (const m of runs) {
      for (const p of m.points) {
        expect(p.x).toBeGreaterThanOrEqual(-1);
        expect(p.x).toBeLessThanOrEqual(H + 1);
        const display = docToRender(p, geometry);
        expect(display.x).toBeGreaterThanOrEqual(-1);
        expect(display.x).toBeLessThanOrEqual(W + 1);
      }
    }
    // Home runs end at the panel (display 83 %, 52 %).
    const end = docToRender(homeRuns[0].points[homeRuns[0].points.length - 1], geometry);
    const start = docToRender(homeRuns[0].points[0], geometry);
    const nearPanel = [start, end].some(p => Math.hypot(p.x - 0.83 * W, p.y - 0.52 * H) < 0.05 * W);
    expect(nearPanel).toBe(true);
    expect(result.modelSummary.code).toBeTruthy();
  });

  it('is approval-gated and registered', async () => {
    const tool = createSuggestRunsTool();
    const addApproval = vi.fn();
    const out = await tool.execute(
      { runId: 'r1', messageId: 'm1', addApproval } as never,
      { page: 4, panel: { label: 'LP', x: 83, y: 52 }, circuits: circuitsFromTags(), settings: { wiringMethod: 'EMT' } } as never,
    );
    expect(out.status).toBe('approval-required');
    expect(addApproval).toHaveBeenCalledTimes(1);
    const approval = addApproval.mock.calls[0][0];
    expect(approval.toolId).toBe('suggest_runs');
    expect(approval.payload.markups.length).toBeGreaterThan(0);
    expect(getAssistantTool('getRunSuggestions')).toBeUndefined();
  });
});
