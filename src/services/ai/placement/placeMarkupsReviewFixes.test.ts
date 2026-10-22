import '../agent/testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasMarkup, CountMarkerMarkup, MarkupStyle } from '@/types/markup';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { createPageGeometry } from './coords';
import { executePlaceMarkupsApproval, newDirectPlaceMarkupsApprovalId } from './executePlaceMarkupsApproval';
import {
  countMarkerCaption,
  resolveMarkupDrawAppearance,
} from '@/components/editor/markupDrawAppearance';
import { commitMarkupsByConfidence } from './confidenceGate';
import { useProductStore } from '@/store/productStore';
import { summarizeMarkupsForChat } from '../contextSummary';
import { handleApprovalDecision, resetApprovalInFlightForTests } from './handleApprovalDecision';
import { normalizeAgentMarkupPayload } from './normalizeAgentMarkupPayload';
import { createAgentToolContext } from '../agent/createToolContext';
import {
  clearPageAnalysisCache,
  countItemsFromAnalysis,
  getLatestFullPageAnalysis,
  setCachedAnalyze,
} from '../agent/pageAnalysisCache';
import { generateOverlappingTileRegions } from '../imageCapture';
import { reconcileTileDetections } from '../pipeline';
import type { DetectedItem } from '../providers/types';
import type { ApprovalRequest } from '@/types/assistant';

const defaultStyle: MarkupStyle = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
  opacity: 100,
};

function item(id: string, page = 1): DetectedItem {
  return {
    id,
    type: 'A',
    trade: 'electrical',
    name: 'A',
    quantity: 1,
    location: { x: 10, y: 20 },
    confidence: 0.9,
    legendTypeCode: 'A',
    matchConfidence: 'high',
  };
}

function seedDoc(docId: string, cacheGeometry = true) {
  const fakePdf = {
    getPage: async () => ({
      rotate: 0,
      getViewport: ({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
      }),
    }),
  };
  useCanvasStore.getState().setPdfDocument(docId, fakePdf, 2, 612, 792);
  if (cacheGeometry) {
    useCanvasStore.getState().cachePageGeometries(new Map([
      [1, createPageGeometry({ pageNumber: 1, docWidth: 612, docHeight: 792, rotationDeg: 0 })],
    ]));
  }
}

function seedAnalysis(
  docId: string,
  page: number,
  items: DetectedItem[],
  revision: number,
  ref?: { analyzedAt: string; analysisId: string },
) {
  setCachedAnalyze(`${docId}|full`, {
    status: 'completed',
    page,
    scope: 'full',
    analysis: {
      page,
      items,
      dimensions: [],
      text: [],
      symbols: [],
      typeCounts: { A: items.length },
    },
    textEvidence: { source: 'native', confidence: 1, context: '', itemCount: items.length },
    analysisRef: ref
      ? { docId, page, revision, analyzedAt: ref.analyzedAt, analysisId: ref.analysisId }
      : undefined,
  }, {
    docId,
    page,
    scope: 'full',
    contentRevision: revision,
    promoteToLatestFull: true,
  });
}

function pageMarkups(docId: string): CanvasMarkup[] {
  return useCanvasStore.getState().pdfDocuments[docId]?.markupsByPage[1] || [];
}

async function executeOnStore(payload: unknown, approvalId: string, messageId = 'msg-1') {
  return executePlaceMarkupsApproval({
    approval: { ...approval(payload), id: approvalId, messageId },
    page: 1,
    pageWidth: 612,
    pageHeight: 792,
    defaultStyle,
    pdfDocument: useCanvasStore.getState().pdfDocuments[useCanvasStore.getState().activeDocId || '']?.pdfDocument,
    addAIMarkupBatch: (rows, pending) => useCanvasStore.getState().addAIMarkupBatch(rows, pending),
    setPendingPlacements: useAIChatStore.getState().setPendingPlacements,
    getPendingPlacements: () => useAIChatStore.getState().pendingPlacements,
  });
}

function countMarker(id: string, extras?: Partial<CountMarkerMarkup>): CountMarkerMarkup {
  return {
    id,
    type: 'count-marker',
    page: 1,
    x: 10,
    y: 20,
    number: 1,
    groupId: 'g',
    style: defaultStyle,
    locked: false,
    author: 'AI',
    createdAt: new Date().toISOString(),
    ...extras,
  };
}

function approval(payload: unknown): ApprovalRequest {
  return {
    id: 'appr-1',
    runId: 'run-1',
    messageId: 'msg-1',
    toolId: 'place_markups',
    title: 'Place',
    description: 'Place',
    status: 'pending',
    payload,
    undoable: true,
    createdAt: new Date().toISOString(),
  };
}

describe('itemIds analysisRef + duplicate markup ids', () => {
  beforeEach(() => {
    clearPageAnalysisCache();
    useCanvasStore.getState().clearAllDocuments();
    useAIChatStore.setState({ pendingPlacements: [], approvals: {} });
    resetApprovalInFlightForTests();
  });

  it('fails when page is omitted, with nothing placed', async () => {
    seedDoc('doc-a');
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    seedAnalysis('doc-a', 1, [item('a1')], revision);
    const execution = await executePlaceMarkupsApproval({
      approval: approval({
        itemIds: ['a1'],
        analysisRef: { docId: 'doc-a', page: 1, revision, analyzedAt: 't0' },
      }),
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      addAIMarkupBatch: () => ({ ok: true, placed: 1 }),
      setPendingPlacements: () => {},
      getPendingPlacements: () => [],
    });
    expect(execution.status).toBe('failed');
    expect(execution.placed).toBe(0);
    expect(execution.error).toMatch(/requires page/);
  });

  it('fails on cache miss, document switch, re-analysis, and foreign page ids', async () => {
    seedDoc('doc-a');
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    seedAnalysis('doc-a', 1, [item('a1')], revision);
    const cached = (await import('../agent/pageAnalysisCache')).getLatestFullPageAnalysis('doc-a', 1, revision);
    const analysisRef = cached?.analysisRef;
    expect(analysisRef).toBeTruthy();

    const run = async (payload: unknown) => executePlaceMarkupsApproval({
      approval: approval(payload),
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      addAIMarkupBatch: () => ({ ok: true, placed: 1 }),
      setPendingPlacements: () => {},
      getPendingPlacements: () => [],
    });

    const miss = await run({
      itemIds: ['a1'],
      page: 2,
      analysisRef: { ...analysisRef!, page: 2 },
    });
    expect(miss.status).toBe('failed');
    expect(miss.placed).toBe(0);
    expect(miss.error).toMatch(/No cached page analysis|not in cached/i);

    const foreign = await run({
      itemIds: ['page2-item'],
      page: 1,
      analysisRef,
    });
    expect(foreign.status).toBe('failed');
    expect(foreign.placed).toBe(0);
    expect(foreign.dropped.some(d => d.reason === 'not in cached page analysis')).toBe(true);

    seedDoc('doc-b');
    const switched = await run({
      itemIds: ['a1'],
      page: 1,
      analysisRef,
    });
    expect(switched.status).toBe('failed');
    expect(switched.placed).toBe(0);
    expect(switched.error).toMatch(/Active document does not match|ask the AI to count again/);

    seedDoc('doc-a');
    const revision2 = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    seedAnalysis('doc-a', 1, [item('a1')], revision2);
    const reanalyzed = await run({
      itemIds: ['a1'],
      page: 1,
      analysisRef: { ...analysisRef!, revision: revision2 },
    });
    expect(reanalyzed.status).toBe('failed');
    expect(reanalyzed.placed).toBe(0);
    expect(reanalyzed.error).toMatch(/re-analyzed after counting/);
  });

  it('generates internal markup ids when the model repeats row.id', async () => {
    const result = await normalizeAgentMarkupPayload({
      payload: [
        { id: 'A1', type: 'count-marker', page: 1, points: [{ x: 10, y: 20 }], label: 'A' },
        { id: 'A1', type: 'count-marker', page: 1, points: [{ x: 30, y: 40 }], label: 'A' },
      ],
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      idPrefix: 'agent_msg',
      messageId: 'msg',
      defaultStyle,
      resolveAnchors: () => [],
    });
    expect(result.markups).toHaveLength(2);
    expect(result.markups[0].markup.id).not.toBe(result.markups[1].markup.id);
    expect(result.markups.every(row => row.markup.id !== 'A1')).toBe(true);
  });

  it('guards double approve so placement and resume run once', async () => {
    seedDoc('doc-a');
    const resume = vi.fn(async () => ({
      runId: 'run-1',
      messageId: 'msg-1',
      status: 'completed' as const,
      agentResult: { status: 'completed', assistantMessage: 'ok' },
    }));
    useAIChatStore.getState().addApproval(approval([
      { type: 'count-marker', page: 1, points: [{ x: 40, y: 50 }], label: 'A' },
    ]));
    const deps = {
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      setPipelineStatus: () => {},
      createEditorToolContext: (runId: string, messageId: string) => createAgentToolContext({
        runId,
        messageId,
        trade: 'electrical' as const,
        placeMarkups: () => ({ placed: 0 }),
      }),
      resumeAfterApproval: resume as never,
    };
    const [first, second] = await Promise.all([
      handleApprovalDecision('appr-1', 'approved', deps),
      handleApprovalDecision('appr-1', 'approved', deps),
    ]);
    expect([first, second].sort()).toEqual(['handled', 'ignored']);
    expect(resume).toHaveBeenCalledTimes(1);
    const markups = useCanvasStore.getState().pdfDocuments['doc-a']?.markupsByPage[1] || [];
    expect(markups).toHaveLength(1);
  });

  it('two place_markups approvals in the same run produce disjoint markup ids', async () => {
    seedDoc('doc-a');
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    seedAnalysis('doc-a', 1, [item('a1'), item('a2')], revision);
    const analysisRef = getLatestFullPageAnalysis('doc-a', 1, revision)?.analysisRef;
    const first = await executeOnStore({
      itemIds: ['a1'],
      page: 1,
      analysisRef,
    }, 'appr-1', 'same-run-msg');
    const second = await executeOnStore({
      itemIds: ['a2'],
      page: 1,
      analysisRef,
    }, 'appr-2', 'same-run-msg');
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    const ids = pageMarkups('doc-a').map(m => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.some(id => id.includes('appr-1'))).toBe(true);
    expect(ids.some(id => id.includes('appr-2'))).toBe(true);
  });

  it('direct path called twice produces disjoint ids', async () => {
    seedDoc('doc-a');
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    seedAnalysis('doc-a', 1, [item('a1'), item('a2')], revision);
    const analysisRef = getLatestFullPageAnalysis('doc-a', 1, revision)?.analysisRef;
    const id1 = newDirectPlaceMarkupsApprovalId('same-msg');
    const id2 = newDirectPlaceMarkupsApprovalId('same-msg');
    expect(id1).not.toBe(id2);
    await executeOnStore({ itemIds: ['a1'], page: 1, analysisRef }, id1, 'same-msg');
    await executeOnStore({ itemIds: ['a2'], page: 1, analysisRef }, id2, 'same-msg');
    const ids = pageMarkups('doc-a').map(m => m.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('addAIMarkupBatch re-IDs an incoming markup whose id already exists', () => {
    seedDoc('doc-a');
    const first = countMarker('dup-id');
    const second = countMarker('dup-id', { x: 40, y: 50 });
    const batch1 = useCanvasStore.getState().addAIMarkupBatch([{ page: 1, markup: first }], false);
    const batch2 = useCanvasStore.getState().addAIMarkupBatch([{ page: 1, markup: second }], false);
    expect(batch1.ok).toBe(true);
    expect(batch2.ok).toBe(true);
    const markups = pageMarkups('doc-a');
    expect(markups).toHaveLength(2);
    expect(markups[0].id).toBe('dup-id');
    expect(markups[1].id).not.toBe('dup-id');
    expect(new Set(markups.map(m => m.id)).size).toBe(2);
  });

  it('pending rows and product links use the re-ID after a colliding batch', () => {
    seedDoc('doc-a');
    useProductStore.getState().loadFromDatabase({
      'prod-a': {
        id: 'prod-a',
        name: 'Fixture A',
        type: 'product',
        parentId: null,
        children: [],
        expanded: false,
        unitOfMeasure: 'ea',
      },
    }, ['prod-a']);
    const existing = countMarker('dup', { x: 10, y: 20 });
    useCanvasStore.getState().addAIMarkupBatch([{ page: 1, markup: existing }], false);
    let pendingIds: string[] = [];
    const incoming = countMarker('dup', { x: 40, y: 50, productId: 'prod-a', aiConfidence: 0.6 });
    commitMarkupsByConfidence({
      markups: [{ page: 1, markup: incoming }],
      addAIMarkupBatch: (rows, pending) => useCanvasStore.getState().addAIMarkupBatch(rows, pending),
      setPendingPlacements: rows => {
        pendingIds = rows.map(row => row.id);
      },
      getPendingPlacements: () => [],
    });
    const markups = pageMarkups('doc-a');
    expect(markups[0].id).toBe('dup');
    expect((markups[0] as CountMarkerMarkup).productId).toBeUndefined();
    const placed = markups[1];
    expect(placed.id).not.toBe('dup');
    expect(pendingIds).toEqual([placed.id]);
    const linked = useProductStore.getState().getMeasurementByMarkupId(placed.id);
    expect(linked?.productId).toBe('prod-a');
    expect(useProductStore.getState().getMeasurementByMarkupId('dup')).toBeNull();
  });

  it('review markers are drawn on the canvas, amber dashed, and excluded from totals', async () => {
    seedDoc('doc-a');
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    const low: DetectedItem = {
      ...item('low1'),
      matchConfidence: 'low',
      confidence: 0.4,
    };
    seedAnalysis('doc-a', 1, [low], revision);
    const analysisRef = getLatestFullPageAnalysis('doc-a', 1, revision)?.analysisRef;
    const req = approval({
      itemIds: ['low1'],
      page: 1,
      analysisRef,
      includeReviewMarkers: true,
    });
    useAIChatStore.getState().addApproval(req);
    const resume = vi.fn(async () => ({
      runId: 'run-1',
      messageId: 'msg-1',
      status: 'completed' as const,
      agentResult: { status: 'completed', assistantMessage: 'ok' },
    }));
    await handleApprovalDecision('appr-1', 'approved', {
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      setPipelineStatus: () => {},
      createEditorToolContext: (runId: string, messageId: string) => createAgentToolContext({
        runId,
        messageId,
        trade: 'electrical' as const,
        placeMarkups: () => ({ placed: 0 }),
      }),
      resumeAfterApproval: resume as never,
    });
    const markups = pageMarkups('doc-a');
    expect(markups).toHaveLength(1);
    expect(markups[0].reviewMarker).toBe(true);
    expect(markups[0].aiPending).toBe(true);
    expect(markups[0].label).toBe('?');
    expect(countMarkerCaption(markups[0])).toBe('?');
    const appearance = resolveMarkupDrawAppearance({ markup: markups[0], scale: 1 });
    expect(appearance.strokeStyle).toBe('#f59e0b');
    expect(appearance.lineDash).toEqual([6, 4]);
    const summary = summarizeMarkupsForChat({ 1: markups }, 1);
    expect(summary).not.toMatch(/count-marker/);
    useCanvasStore.getState().confirmAIMarkup(1, markups[0].id);
    const confirmed = pageMarkups('doc-a')[0];
    expect(confirmed.reviewMarker).toBe(false);
    expect(confirmed.aiPending).toBe(false);
    expect(confirmed.label).not.toBe('?');
    expect(confirmed.style.strokeColor).toBe('#10b981');
    expect(countMarkerCaption(confirmed)).toBeNull();
    expect(summarizeMarkupsForChat({ 1: [confirmed] }, 1)).toMatch(/count-marker/);
    expect(resolveMarkupDrawAppearance({ markup: confirmed, scale: 1 }).strokeStyle).toBeUndefined();
  });

  it('fails when page geometry is missing and places nothing', async () => {
    seedDoc('doc-a', false);
    expect(useCanvasStore.getState().getPageGeometry(1)).toBeNull();
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    seedAnalysis('doc-a', 1, [item('a1')], revision);
    const analysisRef = getLatestFullPageAnalysis('doc-a', 1, revision)?.analysisRef;
    const execution = await executeOnStore({
      itemIds: ['a1'],
      page: 1,
      analysisRef,
    }, 'appr-geo');
    expect(execution.status).toBe('failed');
    expect(execution.placed).toBe(0);
    expect(execution.error).toMatch(/Page geometry unavailable; ask the AI to count again/);
    expect(pageMarkups('doc-a')).toHaveLength(0);
  });

  it('rejects an old analysisRef when two analyses share a timestamp', async () => {
    seedDoc('doc-a');
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    const stamp = '2026-01-01T00:00:00.000Z';
    seedAnalysis('doc-a', 1, [item('a1')], revision, { analyzedAt: stamp, analysisId: 'analysis-old' });
    const oldRef = getLatestFullPageAnalysis('doc-a', 1, revision)?.analysisRef;
    expect(oldRef?.analyzedAt).toBe(stamp);
    seedAnalysis('doc-a', 1, [item('a1')], revision, { analyzedAt: stamp, analysisId: 'analysis-new' });
    const execution = await executeOnStore({
      itemIds: ['a1'],
      page: 1,
      analysisRef: oldRef,
    }, 'appr-stale');
    expect(execution.status).toBe('failed');
    expect(execution.placed).toBe(0);
    expect(execution.error).toMatch(/re-analyzed after counting/);
    expect(pageMarkups('doc-a')).toHaveLength(0);
  });

  it('count then place_markups(itemIds) on a rotated page places exactly the counted items', async () => {
    const fakePdf = {
      getPage: async () => ({
        rotate: 90,
        getViewport: ({ scale }: { scale: number }) => ({
          width: 792 * scale,
          height: 612 * scale,
        }),
      }),
    };
    useCanvasStore.getState().setPdfDocument('doc-rot', fakePdf, 1, 612, 792);
    const page = createPageGeometry({ pageNumber: 1, docWidth: 612, docHeight: 792, rotationDeg: 90 });
    useCanvasStore.getState().cachePageGeometries(new Map([[1, page]]));
    const countedItems: DetectedItem[] = [
      item('a1'),
      item('a2'),
      { ...item('a3'), location: { x: 40, y: 50 } },
    ];
    const revision = useCanvasStore.getState().pdfDocuments['doc-rot']?.contentRevision ?? 0;
    seedAnalysis('doc-rot', 1, countedItems, revision);
    const analysisRef = getLatestFullPageAnalysis('doc-rot', 1, revision)?.analysisRef;
    const counted = countItemsFromAnalysis({
      page: 1,
      items: countedItems,
      dimensions: [],
      text: [],
      symbols: [],
      legendTypeCodes: ['A'],
      legendTypeCounts: { A: 3 },
    }, 'Type A', { pageGeometry: page, analysisRef });
    expect(counted.total).toBe(3);
    expect(counted.matchingItems).toHaveLength(3);
    useAIChatStore.getState().addApproval(approval({
      itemIds: counted.matchingItems.map(row => row.id),
      page: 1,
      analysisRef,
    }));
    await handleApprovalDecision('appr-1', 'approved', {
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      setPipelineStatus: () => {},
      createEditorToolContext: (runId: string, messageId: string) => createAgentToolContext({
        runId,
        messageId,
        trade: 'electrical' as const,
        placeMarkups: () => ({ placed: 0 }),
      }),
      resumeAfterApproval: (async () => ({
        runId: 'run-1',
        messageId: 'msg-1',
        status: 'completed',
        agentResult: { status: 'completed', assistantMessage: 'ok' },
      })) as never,
    });
    const markups = pageMarkups('doc-rot');
    expect(markups).toHaveLength(3);
    expect(new Set(markups.map(m => m.id)).size).toBe(3);
  });

  it('rejects merged-away seam duplicate ids and places the survivor once', async () => {
    const pageW = 720;
    const pageH = 720;
    const regions = generateOverlappingTileRegions(pageW, pageH, 2, 2);
    const left = regions[0];
    const right = regions[1];
    const pageX = 360;
    const pageY = 120;
    const local = (region: typeof left) => ({
      x: ((pageX - region.x) / region.width) * 100,
      y: ((pageY - region.y) / region.height) * 100,
    });
    const reconciled = reconcileTileDetections([
      {
        region: left,
        result: {
          page: 1,
          items: [{ ...item('seam-l'), location: local(left) }],
          dimensions: [],
          text: [],
          symbols: [],
        },
      },
      {
        region: right,
        result: {
          page: 1,
          items: [{ ...item('seam-r'), location: local(right) }],
          dimensions: [],
          text: [],
          symbols: [],
        },
      },
    ], pageW, pageH);
    const survivors = reconciled.filter(row => !row.locationMissing);
    expect(survivors).toHaveLength(1);
    const survivor = survivors[0];
    seedDoc('doc-a');
    const revision = useCanvasStore.getState().pdfDocuments['doc-a']?.contentRevision ?? 0;
    seedAnalysis('doc-a', 1, survivors, revision);
    const analysisRef = getLatestFullPageAnalysis('doc-a', 1, revision)?.analysisRef;
    const mergedAway = survivor.id.includes('seam-l') ? `${right.id}_seam-r` : `${left.id}_seam-l`;
    const execution = await executeOnStore({
      itemIds: [mergedAway, survivor.id],
      page: 1,
      analysisRef,
    }, 'appr-seam');
    expect(pageMarkups('doc-a')).toHaveLength(1);
    expect(execution.dropped.some(d => d.itemId === mergedAway && /not in cached page analysis/.test(d.reason))).toBe(true);
  });
});
