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
  itemIsUnresolvedForCounts: vi.fn(() => ({ unresolved: false })),
}));

import { useCanvasStore } from '@/store/canvasStore';
import { getAssistantTool } from '../tools/registry';
import { runLengthFt } from './overlay';
import { buildRunInputQuestion, createSuggestRunsTool, KEEPOUT_COLOR, RUN_COLOR, panelNameCandidates, prepareRunPlan, specWiringMethod, type RunInputNeeded } from './suggestRunsTool';
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
    // Circuits named LP-n: the panel comes from the tags (and is found on the sheet) — only the
    // wiring method is asked.
    expect(ask.fields.map(f => f.id)).toEqual(['wiring_method']);
    expect(ask.fields.find(f => f.id === 'wiring_method')!.options!.map(o => o.value)).toEqual(['EMT', 'MC', 'PVC40', 'RMC']);
    const args = applyFieldAnswers(ask.resume!.args, ask.resume!.apply, {
      wiring_method: { value: 'MC', label: 'MC cable' },
    });
    expect(args).toMatchObject({ page: 4, documentId: DOC, settings: { wiringMethod: 'MC' } });
    const addApproval = vi.fn();
    const again = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval } as never, args as never);
    expect(again.status).toBe('approval-required');
    expect(again.askUser).toBeUndefined();
  });

  it('circuits from the engineer\'s tags when the model lumps every fixture together', async () => {
    const tagged = circuitsFromTags();
    const lumped = [{ id: 'C1', itemIds: tagged.flatMap(c => c.itemIds), vaPerDevice: 100 }];
    const result = await prepareRunPlan({ page: 4, circuits: lumped, settings: { wiringMethod: 'EMT' } } as never);
    if ('needs' in result) {
      // Panel LP is not uniquely labelled on this sheet: one point question per tag panel.
      expect(result.needs).toBe('input');
      const needed = result as RunInputNeeded;
      expect(needed.panels.map(p => p.label)).toEqual(['LP']);
      expect(needed.panels[0].circuits.length).toBe(tagged.length);
      expect(needed.missing).not.toContain('panel_label');
      const ask = buildRunInputQuestion(needed, { page: 4, circuits: lumped });
      expect(ask.fields[0].id).toBe('panel_loc_0');
      expect(ask.fields[0].options?.some(o => o.value === 'flag:offSheet')).toBe(true);
      const args = applyFieldAnswers(ask.resume!.args, ask.resume!.apply, { panel_loc_0: { point: { page: 4, xPct: 83, yPct: 52 } } });
      expect(args).toMatchObject({ panels: [{ label: 'LP', x: 83, y: 52 }] });
      const again = await prepareRunPlan(args as never);
      if ('needs' in again) throw new Error(again.message);
      const homeRuns = again.markups.map(r => r.markup).filter(m => m.aiRun?.kind === 'homerun');
      expect(homeRuns.length).toBeGreaterThan(1);
      expect(again.markups.some(r => r.markup.aiRun?.kind === 'panel')).toBe(true);
      expect(homeRuns.every(m => !!m.aiRun?.assembly)).toBe(true);
    } else {
      const homeRuns = result.markups.map(r => r.markup).filter(m => m.aiRun?.kind === 'homerun');
      expect(homeRuns.length).toBeGreaterThan(1);
    }
  });

  it('splits circuits between the panels the user picked on the multi-select', async () => {
    const tagged = circuitsFromTags();
    const lumped = [{ id: 'C1', itemIds: tagged.flatMap(c => c.itemIds), vaPerDevice: 100 }];
    const result = await prepareRunPlan({ page: 4, circuits: lumped, panelLabels: ['LP', 'ZQ'], settings: { wiringMethod: 'EMT' } } as never);
    // Every circuit lands on a chosen panel (ZQ has no tags here, so all follow LP's tags).
    if ('needs' in result) {
      const needed = result as RunInputNeeded;
      expect(needed.missing).not.toContain('panel_label');
      expect(needed.panels.flatMap(p => p.circuits).length).toBeGreaterThanOrEqual(tagged.length);
      expect(needed.panels.every(p => ['LP', 'ZQ'].includes(p.label))).toBe(true);
    } else {
      expect(result.markups.some(r => r.markup.aiRun?.kind === 'homerun')).toBe(true);
    }
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

  it('draws visible light-blue runs: branch arcs fixture to fixture, footage stays consistent on edit', async () => {
    const circuits = circuitsFromTags();
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 52 }, circuits, settings: { wiringMethod: 'EMT' } } as never);
    if ('needs' in result) throw new Error(result.message);
    const all = result.markups.map(r => r.markup);
    // Opacity is 0–100: every run-plan markup must be fully visible (was 1 = invisible).
    expect(all.every(m => m.style.opacity === 100)).toBe(true);
    const runs = all.filter(m => m.type === 'polyline') as PolygonMarkup[];
    expect(runs.every(m => m.style.strokeColor === RUN_COLOR)).toBe(true);
    const branches = runs.filter(m => m.aiRun?.kind === 'branch');
    expect(branches.length).toBeGreaterThan(0);
    for (const b of branches) {
      expect(b.aiRun?.curve).toBe(true);
      expect(b.points).toHaveLength(3);
      expect(b.aiRun?.footageFactor ?? 1).toBeGreaterThanOrEqual(1);
      // Recomputing an untouched branch gives the same footage.
      expect(Math.abs(runLengthFt(b.points, b.aiRun!) - b.aiRun!.lengthFt)).toBeLessThan(0.3);
    }
    const home = runs.find(m => m.aiRun?.kind === 'homerun')!;
    expect(home.style.strokeWidth).toBeGreaterThan(branches[0].style.strokeWidth);
    expect(home.aiRun?.circuits?.every(c => typeof c.vdBranchFt === 'number')).toBe(true);
    const keepouts = all.filter(m => m.aiRun?.kind === 'keepout');
    expect(keepouts.every(m => m.style.strokeColor === KEEPOUT_COLOR)).toBe(true);
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

describe('runs follow the placed fixtures', () => {
  it('ties branch strings to the count markers and moves them with the fixture', async () => {
    const { renderToDoc } = await import('../placement/coords');
    const { followAnchoredRuns } = await import('./anchors');
    const circuits = circuitsFromTags();
    const geometry = createPageGeometry({ pageNumber: 4, docWidth: H, docHeight: W, rotationDeg: 90, renderScale: 1 });
    // Count markers sit a little off the analysis locations (as placed / nudged on the print).
    const markers = analysisItems.map(item => {
      const display = { x: (item.location.x / 100) * W + 6, y: (item.location.y / 100) * H + 4 };
      const doc = renderToDoc(display, geometry);
      return {
        id: `cm_${item.id}`, type: 'count-marker', page: 4, x: doc.x, y: doc.y, number: 1, label: 'A',
        aiLinkedItemId: item.id, style: { strokeColor: '#000', fillColor: '#000', strokeWidth: 1, opacity: 100 },
        locked: false, author: 'AI', createdAt: '',
      };
    });
    useCanvasStore.setState(state => ({
      ...state,
      pdfDocuments: { [DOC]: { ...state.pdfDocuments[DOC], markupsByPage: { 4: markers } } } as never,
    }));
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 52 }, circuits, settings: { wiringMethod: 'EMT' }, keepClear: [] } as never);
    if ('needs' in result) throw new Error(result.message);
    const branches = result.markups.map(r => r.markup).filter(m => m.type === 'polyline' && (m as PolygonMarkup).aiRun?.kind === 'branch') as PolygonMarkup[];
    expect(branches.length).toBeGreaterThan(0);
    const byId = new Map(markers.map(m => [m.id, m]));
    for (const b of branches) {
      const anchors = b.aiRun!.anchors!;
      expect(anchors.start && anchors.end).toBeTruthy();
      // The string's ends are exactly on its fixtures.
      const s = byId.get(anchors.start!)!;
      expect(Math.hypot(b.points[0].x - s.x, b.points[0].y - s.y)).toBeLessThan(0.5);
      const e = byId.get(anchors.end!)!;
      expect(Math.hypot(b.points[2].x - e.x, b.points[2].y - e.y)).toBeLessThan(0.5);
    }
    const homeRuns = result.markups.map(r => r.markup).filter(m => (m as PolygonMarkup).aiRun?.kind === 'homerun') as PolygonMarkup[];
    expect(homeRuns.some(h => h.aiRun?.anchors?.start)).toBe(true);

    // Move one fixture: its strings follow, footage updates.
    const target = branches[0];
    const movedId = target.aiRun!.anchors!.end!;
    const moved = { ...byId.get(movedId)!, x: byId.get(movedId)!.x + 40, y: byId.get(movedId)!.y + 25 };
    const page = [...markers.filter(m => m.id !== movedId), moved, ...result.markups.map(r => r.markup)];
    const updates = followAnchoredRuns(page as never, [movedId]);
    const mine = updates.find(u => u.id === target.id)!;
    expect(mine).toBeTruthy();
    const pts = (mine.updates as PolygonMarkup).points;
    expect(Math.hypot(pts[2].x - moved.x, pts[2].y - moved.y)).toBeLessThan(0.01);
    expect(pts[0]).toEqual(target.points[0]);
    expect(mine.lengthFt).not.toBe(target.aiRun!.lengthFt);
    // Runs not tied to that fixture are untouched.
    expect(updates.every(u => {
      const m = page.find(x => x.id === u.id) as PolygonMarkup;
      return m.aiRun?.anchors?.start === movedId || m.aiRun?.anchors?.end === movedId;
    })).toBe(true);
  });
});
