import '../agent/testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkupStyle } from '@/types/markup';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { createPageGeometry } from './coords';
import { executePlaceMarkupsApproval } from './executePlaceMarkupsApproval';
import { handleApprovalDecision, resetApprovalInFlightForTests } from './handleApprovalDecision';
import { normalizeAgentMarkupPayload } from './normalizeAgentMarkupPayload';
import { createAgentToolContext } from '../agent/createToolContext';
import {
  clearPageAnalysisCache,
  setCachedAnalyze,
} from '../agent/pageAnalysisCache';
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

function seedDoc(docId: string) {
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
  useCanvasStore.getState().cachePageGeometries(new Map([
    [1, createPageGeometry({ pageNumber: 1, docWidth: 612, docHeight: 792, rotationDeg: 0 })],
  ]));
}

function seedAnalysis(docId: string, page: number, items: DetectedItem[], revision: number) {
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
  }, {
    docId,
    page,
    scope: 'full',
    contentRevision: revision,
    promoteToLatestFull: true,
  });
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
});
