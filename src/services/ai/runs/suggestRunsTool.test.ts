import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZonePageInput } from '../detection/pageZones';

const fixture: ZonePageInput & { rotate: number } = JSON.parse(gunzipSync(readFileSync(
  path.resolve(__dirname, '../../../test/fixtures/zones/otsego_E210.json.gz'),
)).toString());

const indexState = vi.hoisted(() => ({ rows: [] as Array<{ text?: string }> }));
vi.mock('../projectIndex/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../projectIndex/store')>();
  return { ...actual, allIndexedPages: () => (indexState.rows.length ? indexState.rows : actual.allIndexedPages()) };
});
vi.mock('../detection/pageZones', async importOriginal => {
  const actual = await importOriginal<typeof import('../detection/pageZones')>();
  return {
    ...actual,
    extractZoneInputs: vi.fn(async () => fixture),
    getZoneInputs: vi.fn(async () => fixture),
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
import { buildRunInputQuestion, createSuggestRunsTool, KEEPOUT_COLOR, RUN_COLOR, panelNameCandidates, prepareRunPlan, resetRunDecisions, specWiringMethod, type RunInputNeeded } from './suggestRunsTool';
import { applyFieldAnswers, clearPinnedResumes, formatFieldAnswersForModel, type AskUserRequest } from '../agent/askUser';
import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';
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

/** The user answers the card in the app (pins the answer, like the chat drawer does). */
function answerCard(ask: AskUserRequest, answers: Record<string, unknown>) {
  formatFieldAnswersForModel({ fields: ask.fields, resume: ask.resume } as never, answers as never, 'r1');
  return applyFieldAnswers(ask.resume!.args, ask.resume!.apply, answers as never);
}

const runContext = () => ({
  runId: 'r1', messageId: 'm1', addApproval: vi.fn(), signal: new AbortController().signal,
  getActiveDocument: () => ({ id: DOC, currentPage: 4, totalPages: 4 }),
});

beforeEach(() => {
  indexState.rows = [];
  resetRunDecisions();
  clearPinnedResumes();
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
        markupsByPage: {},
      },
    } as never,
    pageCalibrationsByDoc: {},
  }));
});

describe('complete count coverage', () => {
  const markerStyle = { strokeColor: '#000', fillColor: '#000', strokeWidth: 1, opacity: 100 };
  function placeCounts() {
    const circuits = circuitsFromTags();
    const markers = analysisItems.map(item => ({
      id: `cm_${item.id}`, type: 'count-marker', page: 4,
      x: item.location.x / 100 * W * BASE_RENDER_SCALE,
      y: item.location.y / 100 * H * BASE_RENDER_SCALE,
      aiLinkedItemId: item.id, number: 1, label: 'A', style: markerStyle, locked: false, author: 'AI', createdAt: '',
    }));
    useCanvasStore.setState(state => ({
      pdfDocuments: { [DOC]: { ...state.pdfDocuments[DOC], markupsByPage: { 4: markers } } } as never,
    }));
    return { circuits, markers };
  }

  it('includes every linked marker when the model passes only a subset of fixtures', async () => {
    const { circuits, markers } = placeCounts();
    const shortened = circuits.slice(0, 2).map(c => ({ ...c, itemIds: c.itemIds.slice(0, 1) }));
    const result = await prepareRunPlan({
      page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits: shortened,
      settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [],
    } as never);
    if ('needs' in result) throw new Error(result.message);
    expect(result.coverage.total).toBe(markers.length);
    expect(result.coverage.fixtures.map(f => f.id).sort()).toEqual(markers.map(m => m.id).sort());
    expect(result.coverage.fixtures.every(f => f.circuitIds.length > 0)).toBe(true);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.connected).toBe(markers.length);
  });

  it('keeps stale-linked and hand counts, excludes review candidates, and reports invalid locations', async () => {
    const { circuits, markers } = placeCounts();
    const hand = { ...markers[0], id: 'hand-count', aiLinkedItemId: undefined, x: markers[0].x + 20 };
    const stale = { ...markers[1], id: 'stale-count', aiLinkedItemId: 'old-analysis-id', x: markers[1].x + 20 };
    const review = { ...markers[2], id: 'review-only', reviewMarker: true };
    const invalid = { ...markers[3], id: 'bad-location', x: NaN };
    useCanvasStore.setState(state => ({
      pdfDocuments: { [DOC]: { ...state.pdfDocuments[DOC], markupsByPage: { 4: [...markers, hand, stale, review, invalid] } } } as never,
    }));
    const result = await prepareRunPlan({
      page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits,
      settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [],
    } as never);
    if ('needs' in result) throw new Error(result.message);
    expect(result.coverage.total).toBe(markers.length + 3);
    expect(result.coverage.fixtures.find(f => f.id === hand.id)?.status).toBe('connected');
    expect(result.coverage.fixtures.find(f => f.id === stale.id)?.status).toBe('connected');
    expect(result.coverage.fixtures.some(f => f.id === review.id)).toBe(false);
    expect(result.coverage.fixtures.find(f => f.id === invalid.id)?.status).toBe('missing_location');
    expect(result.coverage.complete).toBe(false);
    expect(result.summaryLines[0]).toContain('INCOMPLETE');
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const { placeSuggestedRuns } = await import('../placement/handleApprovalDecision');
    const { runInputSnapshot } = await import('./runInputSnapshot');
    const placed = placeSuggestedRuns({
      id: 'partial', toolId: 'suggest_runs', runId: 'run', messageId: 'message', status: 'pending',
      title: 'Suggested runs', description: 'Partial layout', undoable: true, createdAt: '',
      payload: {
        documentId: DOC, page: 4, markups: result.markups,
        inputSnapshot: runInputSnapshot(useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4]), coverage: result.coverage,
      },
    });
    expect(placed.status).toBe('partial');
    expect(placed.coverage?.unresolved).toBeGreaterThan(0);
    expect(placed.error).toContain('Do not report this layout as complete');
  });

  it('asks a popup card before assigning untagged omitted counts, ignoring model self-confirmation', async () => {
    const { circuits } = placeCounts();
    const result = await prepareRunPlan({
      page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits: circuits.slice(0, 2),
      autoCircuits: { useCircuitTags: false }, unassignedAction: 'propose',
      settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [],
    } as never, { strict: true });
    expect('needs' in result && result.needs).toBe('input');
    const needed = result as RunInputNeeded;
    expect(needed.missing).toContain('circuit_assignment');
    const card = buildRunInputQuestion(needed, { page: 4 });
    expect(card.fields.find(f => f.id === 'circuit_assignment')?.options?.map(o => o.value)).toEqual(['propose', 'review']);
    expect(card.resume?.apply.circuit_assignment).toBe('unassignedAction');
  });

  it('lets the card leave unassigned counts visibly unresolved instead of guessing their circuit', async () => {
    const { circuits } = placeCounts();
    const result = await prepareRunPlan({
      page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits: circuits.slice(0, 2),
      autoCircuits: { useCircuitTags: false }, unassignedAction: 'review',
      settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [],
    } as never);
    if ('needs' in result) throw new Error(result.message);
    expect(result.coverage.total).toBe(analysisItems.length);
    expect(result.coverage.unresolved).toBeGreaterThan(0);
    expect(result.coverage.fixtures.filter(f => f.status === 'unassigned')).toHaveLength(result.coverage.unresolved);
    expect(result.summaryLines.join(' ')).toContain('left unresolved at your request');
  });
});

describe('suggest_runs tool', () => {
  it('asks for the panel location when the label is not on the sheet', async () => {
    const result = await prepareRunPlan({ page: 4, panel: { label: 'ZZQ-9' }, circuits: circuitsFromTags(), settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
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
    const args = answerCard(ask, {
      wiring_method: { value: 'MC', label: 'MC cable' },
    });
    expect(args).toMatchObject({ page: 4, documentId: DOC, settings: { wiringMethod: 'MC' }, wiringMethodConfirmed: true });
    const addApproval = vi.fn();
    const again = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval } as never, args as never);
    expect(again.status).toBe('approval-required');
    expect(again.askUser).toBeUndefined();
    // A later layout always asks the material again on its card; the last pick is the default.
    const later = await tool.execute({ runId: 'r2', messageId: 'm2', addApproval: vi.fn() } as never, { page: 4, circuits, wiringMethodConfirmed: true } as never);
    const laterField = later.askUser?.fields.find(f => f.id === 'wiring_method');
    expect(laterField?.recommended).toBe('MC');
    // …and the model's own pick is only a recommendation too.
    const swapped = await tool.execute({ runId: 'r3', messageId: 'm3', addApproval: vi.fn() } as never, { page: 4, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
    expect(swapped.askUser?.fields.find(f => f.id === 'wiring_method')?.recommended).toBe('EMT');
  });

  it('never lets the model confirm the material itself (the spec method is only the recommendation)', async () => {
    const tool = createSuggestRunsTool();
    const out = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval: vi.fn() } as never, { page: 4, circuits: circuitsFromTags(), settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
    expect(out.status).toBe('completed');
    expect(out.askUser?.fields.map(f => f.id)).toContain('wiring_method');
  });

  it('always asks the wiring method, pre-selecting the one already given', async () => {
    const tool = createSuggestRunsTool();
    const out = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval: vi.fn() } as never, { page: 4, circuits: circuitsFromTags(), settings: { wiringMethod: 'PVC40' } } as never);
    const field = out.askUser!.fields.find(f => f.id === 'wiring_method')!;
    expect(field).toBeTruthy();
    expect(field.recommended).toBe('PVC40');
  });

  it('asks which scale to use when the calibration and the printed scale disagree', () => {
    const ask = buildRunInputQuestion({
      needs: 'input', message: '', documentId: DOC, page: 4, missing: ['scale'], panels: [], panelArgs: [], candidates: [], panelNames: [],
      scaleConflict: { printed: '1/8" = 1\'-0"', calibration: '1/4" = 1\'-0"' },
    } as never, { page: 4 });
    const field = ask.fields.find(f => f.id === 'scale')!;
    expect(field.options!.map(o => o.value)).toEqual(['printed', 'calibration']);
    expect(field.recommended).toBe('printed');
  });

  it('circuits from the engineer\'s tags when the model lumps every fixture together', async () => {
    const tagged = circuitsFromTags();
    const lumped = [{ id: 'C1', itemIds: tagged.flatMap(c => c.itemIds), vaPerDevice: 100 }];
    const result = await prepareRunPlan({ page: 4, circuits: lumped, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
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
      const args = applyFieldAnswers(ask.resume!.args, ask.resume!.apply, { panel_loc_0: { point: { page: 4, xPct: 83, yPct: 65 } } });
      expect(args).toMatchObject({ panels: [{ label: 'LP', x: 83, y: 65 }] });
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
    const result = await prepareRunPlan({ page: 4, circuits: lumped, panelLabels: ['LP', 'ZQ'], settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
    // Every circuit lands on a chosen panel (ZQ has no tags here, so all follow LP's tags).
    if ('needs' in result) {
      const needed = result as RunInputNeeded;
      expect(needed.missing).not.toContain('panel_label');
      expect(needed.panels.every(p => ['LP', 'ZQ'].includes(p.label))).toBe(true);
      // Every chosen panel is planned, and one with no fixtures on it still gets a location question.
      expect(needed.panelArgs.map(p => p.label).sort()).toEqual(['LP', 'ZQ']);
      expect(needed.panels.some(p => p.label === 'ZQ')).toBe(true);
      expect(needed.missing).toContain('panel_location');
    } else {
      expect(result.markups.some(r => r.markup.aiRun?.kind === 'homerun')).toBe(true);
    }
  });

  it('reads panel names and the wiring method from the specs', () => {
    expect(panelNameCandidates(['PANEL LP-1 SCHEDULE', 'PANEL: LP-1', 'PANELBOARD H1', 'PANEL SCHEDULE'])).toEqual(['LP-1', 'H1']);
    expect(specWiringMethod(['3.1 WIRING METHODS: BRANCH CIRCUITS SHALL BE TYPE MC CABLE', 'NOTES'])).toBe('MC');
    expect(specWiringMethod(['NO RELEVANT TEXT'])).toBeUndefined();
  });

  it('stores runs in the canvas frame (rotation + render scale) so they land where the user sees the page', async () => {
    const circuits = circuitsFromTags();
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
    if ('needs' in result) throw new Error(result.message);
    const runs = result.markups.map(r => r.markup).filter(m => m.type === 'polyline') as PolygonMarkup[];
    const homeRuns = runs.filter(m => m.aiRun?.kind === 'homerun');
    expect(homeRuns.length).toBeGreaterThan(0);
    expect(homeRuns.every(m => /EMT/.test(m.label || ''))).toBe(true);
    // Canvas = the rotated page rendered at BASE_RENDER_SCALE, like count markers and every
    // other markup: each point is inside the rendered page and tagged with that frame.
    expect(runs.every(m => m.aiRun?.frame === 'render')).toBe(true);
    const toDisplay = (p: { x: number; y: number }) => ({ x: p.x / BASE_RENDER_SCALE, y: p.y / BASE_RENDER_SCALE });
    for (const m of runs) {
      for (const p of m.points) {
        expect(p.x).toBeGreaterThanOrEqual(-1);
        expect(p.x).toBeLessThanOrEqual(W * BASE_RENDER_SCALE + 1);
        expect(p.y).toBeLessThanOrEqual(H * BASE_RENDER_SCALE + 1);
      }
    }
    // An in-building destination (83 %, 65 %); the old 83 %, 52 % was in white space.
    const end = toDisplay(homeRuns[0].points[homeRuns[0].points.length - 1]);
    const start = toDisplay(homeRuns[0].points[0]);
    const nearPanel = [start, end].some(p => Math.hypot(p.x - 0.83 * W, p.y - 0.65 * H) < 0.05 * W);
    expect(nearPanel).toBe(true);
    expect(result.modelSummary.code).toBeTruthy();
  });

  it('draws visible light-blue runs: branch arcs fixture to fixture, footage stays consistent on edit', async () => {
    const circuits = circuitsFromTags();
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
    if ('needs' in result) throw new Error(result.message);
    const all = result.markups.map(r => r.markup);
    // Opacity is 0–100: every run-plan markup must be fully visible (was 1 = invisible).
    expect(all.every(m => m.style.opacity === 100)).toBe(true);
    const runs = all.filter(m => m.type === 'polyline') as PolygonMarkup[];
    expect(runs.every(m => m.style.strokeColor === RUN_COLOR)).toBe(true);
    const branches = runs.filter(m => m.aiRun?.kind === 'branch');
    expect(branches.length).toBeGreaterThan(0);
    for (const b of branches) {
      // Fixture strings are arcs; shared-home-run collectors use the safe routed polyline.
      if (!b.aiRun?.runId.endsWith('-collector')) {
        expect(b.aiRun?.curve).toBe(true);
        expect(b.points).toHaveLength(3);
      } else expect(b.points.length).toBeGreaterThanOrEqual(2);
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

  it('locks the panel the user clicked: later runs end there and never move or redraw it', async () => {
    const tool = createSuggestRunsTool();
    const circuits = circuitsFromTags().map(c => ({ ...c, id: c.id.replace('LP', 'C') }));
    const first = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval: vi.fn() } as never, { page: 4, panel: { label: 'ZZQ-9' }, circuits } as never);
    expect(first.askUser!.fields.map(f => f.id)).toEqual(expect.arrayContaining(['panel_location', 'wiring_method']));
    const args = answerCard(first.askUser!, {
      panel_location: { point: { page: 4, xPct: 83, yPct: 65 } },
      wiring_method: { value: 'EMT', label: 'EMT' },
    });
    const addApproval = vi.fn();
    const placed = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval } as never, args as never);
    expect(placed.status).toBe('approval-required');
    // On the page right away (before any approval), locked and marked as the user's.
    const pageMarkups = () => useCanvasStore.getState().getMarkupsByPage(DOC)[4] || [];
    const panel = pageMarkups().find(m => m.aiRun?.kind === 'panel')!;
    expect(panel.aiRun?.userPlaced).toBe(true);
    expect(panel.locked).toBe(true);
    const approval = addApproval.mock.calls[0][0];
    expect(approval.payload.markups.some((r: { markup: { aiRun?: { kind: string } } }) => r.markup.aiRun?.kind === 'panel')).toBe(false);

    // The model re-sends a different spot: the user's panel still wins.
    const again = await prepareRunPlan({ page: 4, panel: { label: 'ZZQ-9', x: 20, y: 20 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never, { strict: true, fromCard: true, cardKeys: ['wiringMethodConfirmed'] });
    if ('needs' in again) throw new Error(again.message);
    const r = panel as unknown as { x: number; y: number; width: number; height: number };
    const centre = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const homeRuns = again.markups.map(m => m.markup as PolygonMarkup).filter(m => m.aiRun?.kind === 'homerun');
    expect(homeRuns.length).toBeGreaterThan(0);
    for (const h of homeRuns) {
      const end = h.points[h.points.length - 1];
      expect(Math.hypot(end.x - centre.x, end.y - centre.y)).toBeLessThan(r.width * 2);
    }

    // Approving the runs replaces old runs but never the user's panel.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), clear: () => store.clear() });
    const { placeSuggestedRuns } = await import('../placement/handleApprovalDecision');
    placeSuggestedRuns({ ...approval, payload: { ...approval.payload, markups: again.markups } } as never);
    const after = pageMarkups().filter(m => m.aiRun?.kind === 'panel');
    expect(after.map(m => m.id)).toEqual([panel.id]);
  });

  it('commits the user\'s keep-clear boxes to the page at once; the model can\'t shift or add copies', async () => {
    const circuits = circuitsFromTags();
    const zonePct = { x: 10, y: 10, width: 8, height: 6 };
    const base = { page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true };
    const first = await prepareRunPlan({ ...base, keepClear: [zonePct], keepClearConfirmed: true } as never, { strict: true, fromCard: true, cardKeys: ['keepClear', 'keepClearConfirmed', 'panel', 'wiringMethodConfirmed'] });
    if ('needs' in first) throw new Error(first.message);
    const zones = () => (useCanvasStore.getState().getMarkupsByPage(DOC)[4] || []).filter(m => m.aiRun?.kind === 'keepout');
    expect(zones()).toHaveLength(1);
    expect(zones()[0].locked).toBe(true);
    // Not redrawn by the run itself.
    expect(first.markups.some(r => r.markup.aiRun?.kind === 'keepout')).toBe(false);
    const before = JSON.stringify(zones()[0]);
    // The model re-types the zone a little off (and adds one): nothing new lands on the page,
    // the user's zone stays exactly where it was, and no card asks again.
    const second = await prepareRunPlan({ ...base, keepClear: [{ ...zonePct, x: 11.5 }, { x: 60, y: 60, width: 5, height: 5 }] } as never, { strict: true, fromCard: true, cardKeys: ['wiringMethodConfirmed'] });
    if ('needs' in second) throw new Error(second.message);
    expect(second.markups.some(r => r.markup.aiRun?.kind === 'keepout')).toBe(false);
    expect(zones()).toHaveLength(1);
    expect(JSON.stringify(zones()[0])).toBe(before);
  });

  it('is approval-gated and registered', async () => {
    const tool = createSuggestRunsTool();
    const addApproval = vi.fn();
    const first = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval: vi.fn() } as never, { page: 4, circuits: circuitsFromTags() } as never);
    const args = answerCard(first.askUser!, { wiring_method: { value: 'EMT', label: 'EMT' } });
    const out = await tool.execute({ runId: 'r1', messageId: 'm1', addApproval } as never, args as never);
    expect(out.status).toBe('approval-required');
    expect(addApproval).toHaveBeenCalledTimes(1);
    const approval = addApproval.mock.calls[0][0];
    expect(approval.toolId).toBe('suggest_runs');
    expect(approval.payload.markups.length).toBeGreaterThan(0);
    // Routed inside the building outline: the white-space check runs and passes.
    const checks = (out.output as { checks: { flagged: string[]; passed: string[] } }).checks;
    expect(checks.flagged.filter(f => /outside the building/.test(f))).toEqual([]);
    expect(checks.passed.some(p => /inside the building/.test(p))).toBe(true);
    expect(getAssistantTool('getRunSuggestions')).toBeUndefined();
  });
});

describe('runs follow the placed fixtures', () => {
  it('ties branch strings to the count markers and moves them with the fixture', async () => {
    const { followAnchoredRuns } = await import('./anchors');
    const circuits = circuitsFromTags();
    // Count markers sit a little off the analysis locations (as placed / nudged on the print),
    // stored like the app stores them: render space (rotated page × BASE_RENDER_SCALE).
    const markers = analysisItems.map(item => {
      const display = { x: (item.location.x / 100) * W + 6, y: (item.location.y / 100) * H + 4 };
      const canvasPt = { x: display.x * BASE_RENDER_SCALE, y: display.y * BASE_RENDER_SCALE };
      return {
        id: `cm_${item.id}`, type: 'count-marker', page: 4, x: canvasPt.x, y: canvasPt.y, number: 1, label: 'A',
        aiLinkedItemId: item.id, style: { strokeColor: '#000', fillColor: '#000', strokeWidth: 1, opacity: 100 },
        locked: false, author: 'AI', createdAt: '',
      };
    });
    useCanvasStore.setState(state => ({
      ...state,
      pdfDocuments: { [DOC]: { ...state.pdfDocuments[DOC], markupsByPage: { 4: markers } } } as never,
    }));
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [] } as never);
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
      const end = b.points[b.points.length - 1];
      expect(Math.hypot(end.x - e.x, end.y - e.y)).toBeLessThan(0.5);
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

  it('keeps keep-clear zones locked where the user put them across runs', async () => {
    const circuits = circuitsFromTags();
    const zonePct = { x: 10, y: 10, width: 8, height: 6 };
    const first = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [zonePct], keepClearConfirmed: true } as never);
    if ('needs' in first) throw new Error(first.message);
    const zone = first.markups.map(r => r.markup).find(m => m.aiRun?.kind === 'keepout')!;
    expect(zone.locked).toBe(true);
    expect(zone.aiRun?.userZone).toBe(true);
    // Placed exactly where the user drew it: page % → canvas render space (the frame they drew in).
    const corner = { x: (zonePct.x / 100) * W * BASE_RENDER_SCALE, y: (zonePct.y / 100) * H * BASE_RENDER_SCALE };
    const z = zone as unknown as { x: number; y: number; width: number; height: number };
    expect(Math.abs(z.x - corner.x)).toBeLessThan(0.5);
    expect(Math.abs(z.y - corner.y)).toBeLessThan(0.5);
    expect(Math.abs(z.width - (zonePct.width / 100) * W * BASE_RENDER_SCALE)).toBeLessThan(0.5);

    // On the page now. The next run reads it back, doesn't redraw it, and doesn't ask again —
    // even when the model re-sends shifted coordinates.
    useCanvasStore.setState(state => ({
      ...state,
      pdfDocuments: { [DOC]: { ...state.pdfDocuments[DOC], markupsByPage: { 4: [zone] } } } as never,
    }));
    const second = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [{ ...zonePct, x: 10.4 }] } as never, { strict: true, fromCard: true, cardKeys: ['wiringMethodConfirmed'] });
    if ('needs' in second) throw new Error(second.message);
    expect(second.markups.some(r => r.markup.aiRun?.kind === 'keepout')).toBe(false);
    const again = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
    expect('needs' in again && (again as RunInputNeeded).missing?.includes('keep_clear')).toBe(false);
  });

  it('uses the card answers exactly, not the model\'s re-typed copy', async () => {
    const { formatFieldAnswersForModel } = await import('../agent/askUser');
    const { withPinnedAnswers } = await import('./suggestRunsTool');
    formatFieldAnswersForModel({
      fields: [{ id: 'keep_clear', kind: 'area', prompt: 'Mark keep-clear areas' }] as never,
      resume: { toolId: 'suggest_runs', args: { documentId: DOC, page: 4, keepClearConfirmed: true }, apply: { keep_clear: 'keepClear' } },
    }, { keep_clear: { areas: [{ xPct: 12.345, yPct: 40.5, wPct: 5, hPct: 4, page: 4 }] } } as never);
    const out = withPinnedAnswers({ page: 4, documentId: DOC, keepClear: [{ x: 12, y: 41, width: 5, height: 4 }], settings: { wiringMethod: 'EMT' } });
    expect((out.keepClear as Array<{ x: number }>)[0].x).toBeCloseTo(12.345, 2);
    expect(out.settings).toBeUndefined(); // Unanswered model additions don't alter the paused request.
    // Used once: a later, unrelated call isn't overridden.
    expect(withPinnedAnswers({ page: 4, keepClear: [] }).keepClear).toEqual([]);
  });

  it('asks for and remembers the exact off-sheet continuation instead of inventing an exit', async () => {
    const tool = createSuggestRunsTool();
    const ctx = runContext();
    const base = { page: 4, panel: { label: 'LP', offSheet: true }, circuits: circuitsFromTags() };
    const first = await tool.execute(ctx as never, base as never);
    const location = first.askUser!.fields!.find(f => f.kind === 'point')!;
    expect(location.prompt).toContain('leave this plan');
    expect(first.askUser!.resume!.apply[location.id]).toMatch(/\.exit$/);
    const ready = await tool.execute(ctx as never, answerCard(first.askUser!, {
      [location.id]: { point: { documentId: DOC, page: 4, xPct: 83, yPct: 65 } },
      wiring_method: { value: 'EMT' }, keep_clear: { areas: [] },
    }) as never);
    expect(ready.status).toBe('approval-required');
    const markers = useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4];
    expect(markers.filter(m => m.aiRun?.userPlaced)).toHaveLength(1);
    expect(markers[0].aiRun).toMatchObject({ offSheet: true, panel: 'LP' });
    const before = JSON.stringify(markers);
    // A rerun asks only the material again (a new layout); the exit point is never re-asked or moved.
    const again = await tool.execute(ctx as never, base as never);
    expect(again.askUser!.fields.map(f => f.id)).toEqual(['wiring_method']);
    expect(again.askUser!.fields[0].recommended).toBe('EMT');
    expect(JSON.stringify(useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4])).toBe(before);
  });

  it('keeps three user-selected panels through reruns and asks before re-picking them', async () => {
    const tool = createSuggestRunsTool();
    const ctx = runContext();
    const labels = ['A', 'B', 'C'];
    const base = {
      page: 4, panelLabels: labels, reviewPanelLocations: true,
      circuits: circuitsFromTags().slice(0, 3).map((c, i) => ({ ...c, id: `${labels[i]}-1` })),
    };
    const first = await tool.execute(ctx as never, base as never);
    const locs = first.askUser!.fields!.filter(f => f.kind === 'point');
    expect(locs).toHaveLength(3);
    const answers = Object.fromEntries(locs.map((f, i) => [f.id, { point: { documentId: DOC, page: 4, xPct: 82 + i * 0.5, yPct: 65 } }]));
    const ready = await tool.execute(ctx as never, answerCard(first.askUser!, { ...answers, wiring_method: { value: 'MC' }, keep_clear: { areas: [] } }) as never);
    expect(ready.status).toBe('approval-required');
    const markers = useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4];
    expect(markers.filter(m => m.aiRun?.userPlaced).map(m => m.aiRun?.panel).sort()).toEqual(labels);
    const before = JSON.stringify(markers);
    const again = await tool.execute(ctx as never, { ...base, reviewPanelLocations: false } as never);
    expect(again.askUser!.fields.map(f => f.id)).toEqual(['wiring_method']);
    expect(JSON.stringify(useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4])).toBe(before);
    const review = await tool.execute(ctx as never, base as never);
    expect(review.askUser!.fields!.filter(f => f.kind === 'point')).toHaveLength(3);
    expect(JSON.stringify(useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4])).toBe(before);
  });

  it('stops an impossible destination with a review card, without offering unsafe runs', async () => {
    const tool = createSuggestRunsTool();
    const ctx = runContext();
    const first = await tool.execute(ctx as never, { page: 4, panel: { label: 'LP' }, reviewPanelLocations: true, circuits: circuitsFromTags() } as never);
    const loc = first.askUser!.fields!.find(f => f.kind === 'point')!;
    const result = await tool.execute(ctx as never, answerCard(first.askUser!, {
      [loc.id]: { point: { documentId: DOC, page: 4, xPct: 83, yPct: 52 } },
      wiring_method: { value: 'EMT' }, keep_clear: { areas: [] },
    }) as never);
    expect(result.output).toMatchObject({ needs: 'routing_review', placed: 0 });
    expect(result.askUser?.fields?.[0].id).toBe('routing_review');
    expect(ctx.addApproval).not.toHaveBeenCalled();
  });

  it('retains overlapping keep-clear boxes rather than shrinking their protected union', async () => {
    const tool = createSuggestRunsTool();
    const ctx = runContext();
    const first = await tool.execute(ctx as never, {
      page: 4, panel: { label: 'LP' }, reviewPanelLocations: true, circuits: circuitsFromTags(),
      keepClear: [10, 14].map(x => ({ x, y: 10, width: 8, height: 6 })),
    } as never);
    expect(first.askUser!.fields!.some(f => f.id === 'keep_clear')).toBe(true);
    const loc = first.askUser!.fields!.find(f => f.kind === 'point')!;
    const result = await tool.execute(ctx as never, answerCard(first.askUser!, {
      [loc.id]: { point: { documentId: DOC, page: 4, xPct: 83, yPct: 65 } },
      wiring_method: { value: 'EMT' },
      keep_clear: { areas: [10, 14].map(xPct => ({ documentId: DOC, page: 4, xPct, yPct: 10, wPct: 8, hPct: 6 })) },
    }) as never);
    expect(result.status, result.summary).toBe('approval-required');
    expect(useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4].filter(m => m.aiRun?.kind === 'keepout')).toHaveLength(2);
  });

  it('does not plan runs when saving card inputs fails', async () => {
    const tool = createSuggestRunsTool();
    const ctx = runContext();
    const first = await tool.execute(ctx as never, { page: 4, panel: { label: 'LP' }, reviewPanelLocations: true, circuits: circuitsFromTags() } as never);
    const loc = first.askUser!.fields!.find(f => f.kind === 'point')!;
    const save = vi.spyOn(useCanvasStore.getState(), 'addAIMarkupBatch').mockReturnValueOnce({ ok: false, placed: 0, reason: 'Source document closed' });
    try {
      const result = await tool.execute(ctx as never, answerCard(first.askUser!, {
        [loc.id]: { point: { documentId: DOC, page: 4, xPct: 83, yPct: 65 } },
        wiring_method: { value: 'EMT' }, keep_clear: { areas: [] },
      }) as never);
      expect(result.output).toMatchObject({ needs: 'document' });
      expect(result.summary).toContain('Could not save your drawing inputs');
      expect(ctx.addApproval).not.toHaveBeenCalled();
      expect(useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4] || []).toEqual([]);
    } finally { save.mockRestore(); }
  });

  it('rejects a stale preview after the user changes a panel input', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const tool = createSuggestRunsTool();
    const ctx = runContext();
    const first = await tool.execute(ctx as never, { page: 4, panel: { label: 'LP' }, reviewPanelLocations: true, circuits: circuitsFromTags() } as never);
    const loc = first.askUser!.fields!.find(f => f.kind === 'point')!;
    await tool.execute(ctx as never, answerCard(first.askUser!, {
      [loc.id]: { point: { documentId: DOC, page: 4, xPct: 83, yPct: 65 } },
      wiring_method: { value: 'EMT' }, keep_clear: { areas: [] },
    }) as never);
    const approval = ctx.addApproval.mock.calls[0][0];
    const doc = useCanvasStore.getState().pdfDocuments[DOC];
    const before = doc.markupsByPage[4].map(m => ({ ...m, label: `${m.label} changed` }));
    useCanvasStore.setState({ pdfDocuments: { [DOC]: { ...doc, markupsByPage: { 4: before } } } });
    const { placeSuggestedRuns } = await import('../placement/handleApprovalDecision');
    expect(placeSuggestedRuns(approval)).toMatchObject({ status: 'failed', placed: 0, error: expect.stringContaining('changed after this preview') });
    expect(useCanvasStore.getState().pdfDocuments[DOC].markupsByPage[4]).toEqual(before);
    vi.unstubAllGlobals();
  });

  it('reads a keep-clear zone saved by an older version where the user drew it, and re-saves it in the canvas frame', async () => {
    const { renderToDoc } = await import('../placement/coords');
    const circuits = circuitsFromTags();
    const zonePct = { x: 10, y: 10, width: 8, height: 6 };
    // Older builds stored run markups in unrotated PDF points (scale 1).
    const legacyGeom = { pageNumber: 4, docWidth: H, docHeight: W, renderScale: 1, rotationDeg: 90 as const };
    const a = renderToDoc({ x: (zonePct.x / 100) * W, y: (zonePct.y / 100) * H }, legacyGeom);
    const b = renderToDoc({ x: ((zonePct.x + zonePct.width) / 100) * W, y: ((zonePct.y + zonePct.height) / 100) * H }, legacyGeom);
    const legacy = {
      id: 'old_zone', type: 'rectangle', page: 4, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
      style: { strokeColor: KEEPOUT_COLOR, fillColor: KEEPOUT_COLOR, strokeWidth: 1, opacity: 30 }, locked: true, author: 'AI', createdAt: '',
      aiRun: { kind: 'keepout', userZone: true, label: 'Keep clear' },
    };
    useCanvasStore.setState(state => ({
      ...state,
      pdfDocuments: { [DOC]: { ...state.pdfDocuments[DOC], markupsByPage: { 4: [legacy] } } } as never,
    }));
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true } as never);
    if ('needs' in result) throw new Error(result.message);
    expect(result.legacyUpgradeIds).toEqual(['old_zone']);
    const up = result.markups.map(r => r.markup).find(m => m.id === 'old_zone') as unknown as { x: number; y: number; width: number; height: number; aiRun: { frame?: string } };
    expect(up.aiRun.frame).toBe('render');
    expect(Math.abs(up.x - (zonePct.x / 100) * W * BASE_RENDER_SCALE)).toBeLessThan(0.5);
    expect(Math.abs(up.y - (zonePct.y / 100) * H * BASE_RENDER_SCALE)).toBeLessThan(0.5);
    expect(Math.abs(up.width - (zonePct.width / 100) * W * BASE_RENDER_SCALE)).toBeLessThan(0.5);
    // No run crosses the zone where the user drew it.
    const box = { x1: up.x, y1: up.y, x2: up.x + up.width, y2: up.y + up.height };
    const runs = result.markups.map(r => r.markup).filter(m => m.type === 'polyline') as PolygonMarkup[];
    for (const r of runs) for (const p of r.points) {
      expect(p.x > box.x1 + 1 && p.x < box.x2 - 1 && p.y > box.y1 + 1 && p.y < box.y2 - 1).toBe(false);
    }
  });

  it('skips fixtures the user deleted and wires fixtures the user placed by hand', async () => {
    const circuits = circuitsFromTags();
    const toCanvasPt = (item: { location: { x: number; y: number } }) => ({ x: (item.location.x / 100) * W * BASE_RENDER_SCALE, y: (item.location.y / 100) * H * BASE_RENDER_SCALE });
    const style = { strokeColor: '#000', fillColor: '#000', strokeWidth: 1, opacity: 100 };
    const deleted = analysisItems[0];
    const markers: Array<Record<string, unknown>> = analysisItems.slice(1).map(item => ({
      id: `cm_${item.id}`, type: 'count-marker', page: 4, ...toCanvasPt(item), number: 1, label: 'A', aiLinkedItemId: item.id, style, locked: false, author: 'AI', createdAt: '',
    }));
    // A fixture the user added by hand, next to one of the AI's.
    const near = toCanvasPt(analysisItems[1]);
    markers.push({ id: 'cm_hand', type: 'count-marker', page: 4, x: near.x + 30, y: near.y, number: 1, label: 'A', style, locked: false, author: 'User', createdAt: '' });
    useCanvasStore.setState(state => ({
      ...state,
      pdfDocuments: { [DOC]: { ...state.pdfDocuments[DOC], markupsByPage: { 4: markers } } } as never,
    }));
    const result = await prepareRunPlan({ page: 4, panel: { label: 'LP', x: 83, y: 65 }, circuits, settings: { wiringMethod: 'EMT' }, wiringMethodConfirmed: true, keepClear: [] } as never);
    if ('needs' in result) throw new Error(result.message);
    const runs = result.markups.map(r => r.markup).filter(m => m.type === 'polyline') as PolygonMarkup[];
    const anchored = new Set(runs.flatMap(r => [r.aiRun?.anchors?.start, r.aiRun?.anchors?.end]).filter(Boolean));
    expect(anchored.has('cm_hand')).toBe(true);
    const gone = toCanvasPt(deleted);
    for (const r of runs) {
      for (const p of [r.points[0], r.points[r.points.length - 1]]) expect(Math.hypot(p.x - gone.x, p.y - gone.y)).toBeGreaterThan(1);
    }
  });

  it('per-panel layouts confirm the panel set first when the schedules list a panel the tags miss', async () => {
    indexState.rows = [{ text: 'PANEL: A\nPANEL: B\nPANEL: C' }];
    const tool = createSuggestRunsTool();
    const ctx = runContext();
    const circuits = circuitsFromTags().slice(0, 2).map((c, i) => ({ ...c, id: `${['A', 'B'][i]}-1` }));
    const out = await tool.execute(ctx as never, { page: 4, circuits } as never);
    const fields = out.askUser!.fields;
    const panelField = fields.find(f => f.id === 'panel_label')!;
    expect(panelField.multi).toBe(true);
    expect(panelField.options!.map(o => o.value)).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    // The locations are asked on the next card, for the panels the user keeps.
    expect(fields.some(f => f.kind === 'point')).toBe(false);
    expect(fields.some(f => f.id === 'wiring_method')).toBe(true);
    const next = await tool.execute(ctx as never, answerCard(out.askUser!, {
      panel_label: { value: 'A,B', label: 'Panel A, Panel B' }, wiring_method: { value: 'EMT' },
    }) as never);
    const nextFields = next.askUser!.fields;
    expect(nextFields.filter(f => f.kind === 'point')).toHaveLength(2);
    // Already answered on the first card: not asked again.
    expect(nextFields.some(f => f.id === 'wiring_method' || f.id === 'panel_label')).toBe(false);
  });
});
