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
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
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

import { approvalPayloadFromPlaceMarkups, placeMarkupsSchema } from '../tools/mutationSchemas';
import { getAssistantTool } from '../tools/registry';

const deps = () => ({
  pageWidth: 612, pageHeight: 792, defaultStyle, setPipelineStatus: () => {},
  createEditorToolContext: (runId: string, messageId: string) => createAgentToolContext({ runId, messageId, trade: 'electrical' as const, placeMarkups: () => ({ placed: 0 }) }),
  resumeAfterApproval: (async () => ({ runId: 'run-1', messageId: 'msg-1', status: 'completed', agentResult: { status: 'completed', assistantMessage: 'ok' } })) as never,
});

describe('ROUND2 B5 review', () => {
  beforeEach(() => {
    clearPageAnalysisCache();
    useCanvasStore.getState().clearAllDocuments();
    useAIChatStore.setState({ pendingPlacements: [], approvals: {} });
    resetApprovalInFlightForTests();
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
  });

  it('itemIds via the REAL schema->payload path lands on non-active doc-b', async () => {
    seedDoc('doc-a'); seedDoc('doc-b');
    useCanvasStore.getState().setActiveDocId('doc-a');
    const rev = useCanvasStore.getState().pdfDocuments['doc-b']?.contentRevision ?? 0;
    seedAnalysis('doc-b', 1, [item('b1'), item('b2')], rev);
    const analysisRef = getLatestFullPageAnalysis('doc-b', 1, rev)?.analysisRef;
    const input = placeMarkupsSchema.parse({ itemIds: ['b1', 'b2'], page: 1, analysisRef, documentId: 'doc-b', description: 'x' });
    const payload = approvalPayloadFromPlaceMarkups(input);
    console.log('[R2] payload keys', Object.keys(payload as object));
    useAIChatStore.getState().addApproval({ ...approval(payload), id: 'x1' });
    await handleApprovalDecision('x1', 'approved', deps());
    console.log('[R2] b5 itemIds: doc-b', pageMarkups('doc-b').length, 'doc-a', pageMarkups('doc-a').length, 'active', useCanvasStore.getState().activeDocId);
    expect(pageMarkups('doc-b').length).toBe(2);
    expect(pageMarkups('doc-a').length).toBe(0);
  });

  it('itemIds with ONLY analysisRef (no documentId) still lands on doc-b', async () => {
    seedDoc('doc-a'); seedDoc('doc-b');
    useCanvasStore.getState().setActiveDocId('doc-a');
    const rev = useCanvasStore.getState().pdfDocuments['doc-b']?.contentRevision ?? 0;
    seedAnalysis('doc-b', 1, [item('b1')], rev);
    const analysisRef = getLatestFullPageAnalysis('doc-b', 1, rev)?.analysisRef;
    const payload = approvalPayloadFromPlaceMarkups(placeMarkupsSchema.parse({ itemIds: ['b1'], page: 1, analysisRef, description: 'x' }));
    useAIChatStore.getState().addApproval({ ...approval(payload), id: 'x2' });
    await handleApprovalDecision('x2', 'approved', deps());
    expect(pageMarkups('doc-b').length).toBe(1);
  });

  it('unknown documentId on place_markups (explicit markups) must not place on the active doc', async () => {
    seedDoc('doc-a');
    useCanvasStore.getState().setActiveDocId('doc-a');
    const payload = { documentId: 'doc-ghost', page: 1, markups: [{ page: 1, markup: countMarker('m1') }] };
    useAIChatStore.getState().addApproval({ ...approval(payload), id: 'x3' });
    await handleApprovalDecision('x3', 'approved', deps());
    const st = useAIChatStore.getState().approvals['x3'];
    console.log('[R2] ghost pending', useAIChatStore.getState().pendingPlacements.map(p => p.id));
    console.log('[R2] unknown doc place: active', useCanvasStore.getState().activeDocId, 'doc-a markups', pageMarkups('doc-a').length, 'approval status', st?.status);
    expect(useCanvasStore.getState().activeDocId).toBe('doc-a');
    expect(pageMarkups('doc-a').length).toBe(0);
  });

  it('control: same explicit-markups payload with a valid non-active documentId', async () => {
    seedDoc('doc-a'); seedDoc('doc-b');
    useCanvasStore.getState().setActiveDocId('doc-a');
    const payload = { documentId: 'doc-b', page: 1, markups: [{ page: 1, markup: countMarker('m1') }] };
    useAIChatStore.getState().addApproval({ ...approval(payload), id: 'x4' });
    await handleApprovalDecision('x4', 'approved', deps());
    const pend = useAIChatStore.getState().pendingPlacements.length;
    console.log('[R2] control explicit markups: doc-b', pageMarkups('doc-b').length, 'doc-a', pageMarkups('doc-a').length, 'pending', pend, 'status', useAIChatStore.getState().approvals['x4']?.status);
  });

  it('navigate_page / analyze with unknown documentId never changes active doc', async () => {
    seedDoc('doc-a');
    useCanvasStore.getState().setActiveDocId('doc-a');
    const ctx = createAgentToolContext({ runId: 'r', messageId: 'm', trade: 'electrical' as const, placeMarkups: () => ({ placed: 0 }) });
    const nav = getAssistantTool('navigate_page')!;
    const r = await nav.execute(ctx, nav.schema.parse({ page: 1, documentId: 'doc-ghost' }) as never);
    ctx.navigateToPage(1, undefined, 'doc-ghost');
    console.log('[R2] nav unknown', r.status, useCanvasStore.getState().activeDocId);
    expect(r.status).toBe('failed');
    expect(useCanvasStore.getState().activeDocId).toBe('doc-a');
  });
});
