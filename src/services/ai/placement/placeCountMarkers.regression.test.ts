import '../agent/testGlobals';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MarkupStyle } from '@/types/markup';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { BASE_RENDER_SCALE, createPageGeometry, docToRender } from './coords';
import { convertPlacementsToMarkups } from './convertPlacements';
import { normalizeAgentMarkupPayload } from './normalizeAgentMarkupPayload';
import { partitionMarkupsByConfidence } from './confidenceGate';
import { executePlaceMarkupsApproval } from './executePlaceMarkupsApproval';
import { placementMarkupsFromCachedItemIds } from './cachedCountMarkers';
import { countItemsFromAnalysis } from '../agent/pageAnalysisCache';
import {
  clearAgentSessionMemoryForTests,
  resumeAgentAfterApproval,
  setAgentSession,
} from '../agent/runnerCore';
import { createAgentToolContext } from '../agent/createToolContext';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
import type { DetectedItem } from '../providers/types';
import type { ApprovalRequest } from '@/types/assistant';

const defaultStyle: MarkupStyle = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
  opacity: 100,
};

const COUNTS = { A: 9, B: 5, EX1: 4, ER1: 2, S: 6 } as const;

function labelOnlyCountPayload() {
  const rows: Array<Record<string, unknown>> = [];
  let i = 0;
  for (const [code, n] of Object.entries(COUNTS)) {
    for (let k = 0; k < n; k += 1) {
      i += 1;
      rows.push({
        type: 'count-marker',
        page: 1,
        points: [{ x: 40 + i * 12, y: 80 + (i % 8) * 20 }],
        label: code,
      });
    }
  }
  return rows;
}

describe('count-marker placement regression (v1.3.45 E-100)', () => {
  it('normalizes the 26-row label-only points payload and converts 26 count markers', async () => {
    const payload = labelOnlyCountPayload();
    expect(payload).toHaveLength(26);
    const result = await normalizeAgentMarkupPayload({
      payload,
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      idPrefix: 'e100',
      messageId: 'msg_e100',
      defaultStyle,
      resolveAnchors: () => [],
    });
    expect(result.dropped).toEqual([]);
    expect(result.markups).toHaveLength(26);
    expect(result.markups.every(row => row.markup.type === 'count-marker')).toBe(true);

    let committed = 0;
    const execution = await executePlaceMarkupsApproval({
      approval: {
        id: 'a-e100',
        runId: 'r-e100',
        messageId: 'msg_e100',
        toolId: 'place_markups',
        title: 'Place',
        description: '26 preliminary label-only count markers',
        status: 'pending',
        payload,
        undoable: true,
        createdAt: new Date().toISOString(),
      },
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      addAIMarkupBatch: (rows) => {
        committed += rows.length;
        return { ok: true, placed: rows.length };
      },
      setPendingPlacements: () => {},
      getPendingPlacements: () => [],
    });
    expect(execution.status).toBe('ok');
    expect(execution.placed).toBe(26);
    expect(committed).toBe(26);
  });

  it('rows with neither point nor points fail with an explicit per-row reason (no TypeError)', async () => {
    const result = await normalizeAgentMarkupPayload({
      payload: [
        { type: 'count-marker', page: 1, label: 'A' },
        { type: 'count-marker', page: 1, points: [{ x: 10, y: 20 }], label: 'B' },
      ],
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      idPrefix: 'mix',
      messageId: 'msg_mix',
      defaultStyle,
      resolveAnchors: () => [],
    });
    expect(result.dropped.some(d => d.index === 0 && d.reason.includes('no point/points'))).toBe(true);
    expect(result.markups).toHaveLength(1);
    expect(() => partitionMarkupsByConfidence([
      { page: 1, markup: undefined as never },
      ...result.markups,
    ])).not.toThrow();
  });

  it('mixed valid/invalid rows return a partial execution listing dropped rows', async () => {
    const execution = await executePlaceMarkupsApproval({
      approval: {
        id: 'a1',
        runId: 'r1',
        messageId: 'm1',
        toolId: 'place_markups',
        title: 'Place',
        description: 'Place',
        status: 'pending',
        payload: [
          { type: 'count-marker', page: 1, label: 'missing' },
          { type: 'count-marker', page: 1, points: [{ x: 50, y: 60 }], label: 'A' },
        ],
        undoable: true,
        createdAt: new Date().toISOString(),
      },
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      addAIMarkupBatch: () => ({ ok: true, placed: 1 }),
      setPendingPlacements: () => {},
      getPendingPlacements: () => [],
    });
    expect(execution.status).toBe('partial');
    expect(execution.placed).toBeGreaterThanOrEqual(1);
    expect(execution.dropped.some(d => d.reason.includes('no point/points'))).toBe(true);
  });

  it('all-invalid payload fails with 0 of N usable coordinates, not a TypeError', async () => {
    const execution = await executePlaceMarkupsApproval({
      approval: {
        id: 'a2',
        runId: 'r1',
        messageId: 'm1',
        toolId: 'place_markups',
        title: 'Place',
        description: 'Place',
        status: 'pending',
        payload: Array.from({ length: 26 }, () => ({ type: 'count-marker', page: 1, label: 'A' })),
        undoable: true,
        createdAt: new Date().toISOString(),
      },
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      addAIMarkupBatch: () => ({ ok: true, placed: 0 }),
      setPendingPlacements: () => {},
      getPendingPlacements: () => [],
    });
    expect(execution.status).toBe('failed');
    expect(execution.error).toMatch(/0 of 26 markers had usable coordinates/);
    expect(execution.error).toMatch(/row 1: no point\/points/);
  });

  it('no active document is reported as failed, not placed N', async () => {
    const execution = await executePlaceMarkupsApproval({
      approval: {
        id: 'a3',
        runId: 'r1',
        messageId: 'm1',
        toolId: 'place_markups',
        title: 'Place',
        description: 'Place',
        status: 'pending',
        payload: [{ type: 'count-marker', page: 1, points: [{ x: 10, y: 20 }], label: 'A' }],
        undoable: true,
        createdAt: new Date().toISOString(),
      },
      page: 1,
      pageWidth: 612,
      pageHeight: 792,
      defaultStyle,
      addAIMarkupBatch: () => ({ ok: false, placed: 0, reason: 'No active document' }),
      setPendingPlacements: () => {},
      getPendingPlacements: () => [],
    });
    expect(execution.status).toBe('failed');
    expect(execution.placed).toBe(0);
    expect(execution.error).toMatch(/No active document/);
  });
});

describe('itemIds placement uses cached DocPoints', () => {
  it('converts page-percent detections to DocPoints and respects 90/180/270 rotation', () => {
    const page = createPageGeometry({
      pageNumber: 1,
      docWidth: 612,
      docHeight: 792,
      renderScale: BASE_RENDER_SCALE,
      rotationDeg: 90,
    });
    const items: DetectedItem[] = [{
      id: 'ex1-1',
      type: 'EX1',
      trade: 'electrical',
      name: 'EX1',
      quantity: 1,
      location: { x: (100 / 612) * 100, y: (200 / 792) * 100 },
      confidence: 0.9,
      legendTypeCode: 'EX1',
      matchConfidence: 'high',
    }];
    const looked = placementMarkupsFromCachedItemIds({
      itemIds: ['ex1-1'],
      page: 1,
      idPrefix: 'cached',
      defaultStyle,
      pageWidth: 612,
      pageHeight: 792,
      items,
    });
    expect(looked.dropped).toEqual([]);
    expect(looked.markups[0].points[0].x).toBeCloseTo(100, 5);
    expect(looked.markups[0].points[0].y).toBeCloseTo(200, 5);

    for (const rotationDeg of [90, 180, 270] as const) {
      const rotated = createPageGeometry({ ...page, rotationDeg });
      const expected = docToRender(looked.markups[0].points[0], rotated);
      const converted = convertPlacementsToMarkups(
        { notes: [], markups: looked.markups },
        defaultStyle,
        'g',
        BASE_RENDER_SCALE,
        BASE_RENDER_SCALE,
        undefined,
        new Map([[1, rotated]]),
      );
      expect(converted[0].markup).toMatchObject({
        type: 'count-marker',
        x: expected.x,
        y: expected.y,
      });
    }
  });

  it('does not place unresolved/low items as normal count markers', () => {
    const items: DetectedItem[] = [
      {
        id: 'ok',
        type: 'A',
        trade: 'electrical',
        name: 'A',
        quantity: 1,
        location: { x: 10, y: 10 },
        confidence: 0.9,
        legendTypeCode: 'A',
        matchConfidence: 'high',
      },
      {
        id: 'low',
        type: 'B',
        trade: 'electrical',
        name: 'B',
        quantity: 1,
        location: { x: 20, y: 20 },
        confidence: 0.4,
        legendTypeCode: 'B',
        matchConfidence: 'low',
      },
    ];
    const skipped = placementMarkupsFromCachedItemIds({
      itemIds: ['ok', 'low'],
      page: 1,
      idPrefix: 'c',
      defaultStyle,
      pageWidth: 612,
      pageHeight: 792,
      items,
    });
    expect(skipped.markups).toHaveLength(1);
    expect(skipped.dropped.some(d => d.itemId === 'low')).toBe(true);

    const review = placementMarkupsFromCachedItemIds({
      itemIds: ['ok', 'low'],
      page: 1,
      includeReviewMarkers: true,
      idPrefix: 'c',
      defaultStyle,
      pageWidth: 612,
      pageHeight: 792,
      items,
    });
    expect(review.markups).toHaveLength(2);
    expect(review.markups.find(m => m.linkedItemId === 'low')?.label).toMatch(/unconfirmed/i);
  });
});

describe('count_page_items compact DocPoints', () => {
  it('returns DocPoint locations and excludes unresolved/low from matchingItems', () => {
    const counted = countItemsFromAnalysis({
      page: 1,
      items: [
        {
          id: 'a1',
          type: 'A',
          trade: 'electrical',
          name: 'A',
          quantity: 1,
          location: { x: 10, y: 20 },
          confidence: 0.9,
          legendTypeCode: 'A',
          matchConfidence: 'high',
        },
        {
          id: 'low1',
          type: 'B',
          trade: 'electrical',
          name: 'B',
          quantity: 1,
          location: { x: 30, y: 40 },
          confidence: 0.4,
          legendTypeCode: 'B',
          matchConfidence: 'low',
        },
      ],
      dimensions: [],
      text: [],
      symbols: [],
      legendTypeCounts: { A: 1, B: 0 },
    }, '', { pageWidth: 1000, pageHeight: 800 });

    expect(counted.matchingItems[0].location).toEqual({ x: 100, y: 160 });
    expect(counted.matchingItems.every(i => i.id !== 'low1')).toBe(true);
    expect(counted.unresolvedItems?.some(i => i.id === 'low1')).toBe(true);
    expect(counted.matchingItems[0].location?.x).toBeGreaterThan(50);
  });
});

describe('failed placement resumes the agent', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    clearAgentSessionMemoryForTests();
    useAIChatStore.setState({
      messages: [],
      runs: {},
      approvals: {},
      conversation: null,
      conversationContextId: null,
      conversationHydrated: false,
    });
    useCanvasStore.getState().clearAllDocuments();
  });

  it('does not leave the run waiting-approval after a failed execute', async () => {
    const messageId = useAIChatStore.getState().addMessage({
      role: 'assistant',
      content: '',
      isLoading: true,
    });
    const runId = useAIChatStore.getState().createRun(messageId, 'place');
    const approval: ApprovalRequest = {
      id: 'appr-fail',
      runId,
      messageId,
      toolId: 'place_markups',
      title: 'Place',
      description: 'Place markers',
      status: 'pending',
      payload: [],
      undoable: true,
      createdAt: new Date().toISOString(),
      toolCallId: 'call_place_fail',
    };
    useAIChatStore.getState().addApproval(approval);
    useAIChatStore.getState().finishRun(runId, 'waiting-approval');

    setAgentSession({
      runId,
      messageId,
      messages: [
        { role: 'user', content: 'Place count markers' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_place_fail', name: 'place_markups', arguments: {} }],
        },
        {
          role: 'tool',
          name: 'place_markups',
          toolCallId: 'call_place_fail',
          content: '{"status":"approval-required"}',
        },
      ],
      toolHistory: [],
      actionsTaken: [],
      contextText: '',
      pendingApprovalId: approval.id,
      continuation: { kind: 'agent', waitingFor: 'approval' },
    });

    const complete = vi.fn(async () => ({
      type: 'final' as const,
      message: 'Placement failed because coordinates were missing.',
    }));

    const result = await resumeAgentAfterApproval({
      runId,
      approval,
      decision: 'approved',
      toolContext: createAgentToolContext({
        runId,
        messageId,
        trade: 'electrical',
        placeMarkups: () => ({ placed: 0 }),
      }),
      executionResult: {
        status: 'failed',
        error: '0 of 26 markers had usable coordinates (row 1: no point/points)',
        perMarker: [{ index: 0, reason: 'no point/points' }],
      },
      model: { complete },
    });

    expect(result.status).not.toBe('needs_approval');
    expect(complete).toHaveBeenCalled();
    const calls = complete.mock.calls as unknown as Array<[{ messages?: Array<{ role?: string; toolCallId?: string; content?: string }> }]>;
    const firstArg = calls[0]?.[0];
    const toolMsg = firstArg?.messages?.find(
      (m) => m.role === 'tool' && m.toolCallId === 'call_place_fail',
    );
    expect(String((toolMsg as { content?: string })?.content || '')).toMatch(/0 of 26 markers/);
    const run = useAIChatStore.getState().runs[runId];
    expect(run?.status).not.toBe('waiting-approval');
  });
});
