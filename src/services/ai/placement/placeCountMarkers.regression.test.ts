import '../agent/testGlobals';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MarkupStyle } from '@/types/markup';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { createPageGeometry } from './coords';
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
    let pendingWrites = 0;
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
      setPendingPlacements: () => {
        pendingWrites += 1;
      },
      getPendingPlacements: () => [],
    });
    expect(execution.status).toBe('failed');
    expect(execution.placed).toBe(0);
    expect(execution.error).toMatch(/No active document/);
    expect(pendingWrites).toBe(0);
  });
});

/**
 * Independent display-percent → DocPoint oracle from the clockwise rotation table
 * (not visionDisplayPctToDoc / unrotateRenderPointToDoc).
 * 90: display (H-y, x) ⇒ doc (dy, H-dx)
 * 180: display (W-x, H-y) ⇒ doc (W-dx, H-dy)
 * 270: display (y, W-x) ⇒ doc (W-dy, dx)
 */
function expectedDisplayPctToDoc(
  xPct: number,
  yPct: number,
  docW: number,
  docH: number,
  rotationDeg: 0 | 90 | 180 | 270,
  crop?: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const dispW = rotationDeg === 90 || rotationDeg === 270 ? docH : docW;
  const dispH = rotationDeg === 90 || rotationDeg === 270 ? docW : docH;
  const region = crop ?? { x: 0, y: 0, width: dispW, height: dispH };
  const dx = region.x + (xPct / 100) * region.width;
  const dy = region.y + (yPct / 100) * region.height;
  if (rotationDeg === 90) return { x: dy, y: docH - dx };
  if (rotationDeg === 180) return { x: docW - dx, y: docH - dy };
  if (rotationDeg === 270) return { x: docW - dy, y: dx };
  return { x: dx, y: dy };
}

describe('itemIds placement uses cached DocPoints', () => {
  it('converts display-space percents through real page rotation (0/90/180/270, crop, non-square)', () => {
    const cases: Array<{
      docW: number;
      docH: number;
      rotationDeg: 0 | 90 | 180 | 270;
      crop?: { x: number; y: number; width: number; height: number };
    }> = [
      { docW: 612, docH: 792, rotationDeg: 0 },
      { docW: 612, docH: 792, rotationDeg: 90 },
      { docW: 612, docH: 792, rotationDeg: 180 },
      { docW: 612, docH: 792, rotationDeg: 270 },
      { docW: 612, docH: 1000, rotationDeg: 90 },
      {
        docW: 612,
        docH: 1000,
        rotationDeg: 90,
        crop: { x: 40, y: 30, width: 500, height: 400 },
      },
    ];
    for (const spec of cases) {
      const page = createPageGeometry({
        pageNumber: 1,
        docWidth: spec.docW,
        docHeight: spec.docH,
        renderScale: 1,
        rotationDeg: spec.rotationDeg,
      });
      const loc = { x: 25, y: 10 };
      const expected = expectedDisplayPctToDoc(
        loc.x,
        loc.y,
        spec.docW,
        spec.docH,
        spec.rotationDeg,
        spec.crop,
      );
      const items: DetectedItem[] = [{
        id: 'ex1-1',
        type: 'EX1',
        trade: 'electrical',
        name: 'EX1',
        quantity: 1,
        location: loc,
        confidence: 0.9,
        legendTypeCode: 'EX1',
        matchConfidence: 'high',
      }];
      const looked = placementMarkupsFromCachedItemIds({
        itemIds: ['ex1-1'],
        page: 1,
        idPrefix: 'cached',
        defaultStyle,
        pageGeometry: page,
        items,
        crop: spec.crop,
      });
      expect(looked.dropped).toEqual([]);
      expect(looked.markups[0].points[0].x).toBeCloseTo(expected.x, 5);
      expect(looked.markups[0].points[0].y).toBeCloseTo(expected.y, 5);

      const counted = countItemsFromAnalysis({
        page: 1,
        items,
        dimensions: [],
        text: [],
        symbols: [],
        legendTypeCounts: { EX1: 1 },
      }, '', { pageGeometry: page, crop: spec.crop });
      expect(counted.matchingItems[0].x).toBeCloseTo(Math.round(expected.x * 10) / 10, 5);
      expect(counted.matchingItems[0].y).toBeCloseTo(Math.round(expected.y * 10) / 10, 5);
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
    const reviewMarkup = review.markups.find(m => m.linkedItemId === 'low');
    expect(reviewMarkup?.label).toBe('?');
    expect(reviewMarkup?.pending).toBe(true);
    expect(reviewMarkup?.style.strokeColor).toBe('#f59e0b');
  });

  it('drops duplicate itemIds', () => {
    const items: DetectedItem[] = [{
      id: 'ok',
      type: 'A',
      trade: 'electrical',
      name: 'A',
      quantity: 1,
      location: { x: 10, y: 10 },
      confidence: 0.9,
      legendTypeCode: 'A',
      matchConfidence: 'high',
    }];
    const result = placementMarkupsFromCachedItemIds({
      itemIds: ['ok', 'ok'],
      page: 1,
      idPrefix: 'c',
      defaultStyle,
      pageWidth: 612,
      pageHeight: 792,
      items,
    });
    expect(result.markups).toHaveLength(1);
    expect(result.dropped.some(d => d.reason === 'duplicate itemId')).toBe(true);
  });

  it('drops invalid-code and no-location items even as review markers', () => {
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
        id: 'bad-code',
        type: 'ZZZ',
        trade: 'electrical',
        name: 'ZZZ',
        quantity: 1,
        location: { x: 20, y: 20 },
        confidence: 0.9,
        legendTypeCode: 'ZZZ',
        matchConfidence: 'high',
      },
      {
        id: 'ghost',
        type: 'A',
        trade: 'electrical',
        name: 'A',
        quantity: 1,
        location: { x: Number.NaN, y: Number.NaN },
        confidence: 0.9,
        legendTypeCode: 'A',
        matchConfidence: 'high',
        locationMissing: true,
      },
    ];
    const result = placementMarkupsFromCachedItemIds({
      itemIds: ['ok', 'bad-code', 'ghost'],
      page: 1,
      includeReviewMarkers: true,
      idPrefix: 'c',
      defaultStyle,
      pageWidth: 612,
      pageHeight: 792,
      items,
      legendTypeCodes: ['A'],
    });
    expect(result.markups.map(row => row.linkedItemId)).toEqual(['ok']);
    expect(result.dropped.some(d => d.itemId === 'bad-code')).toBe(true);
    expect(result.dropped.some(d => d.itemId === 'ghost' && d.reason === 'no location')).toBe(true);
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

    expect(counted.matchingItems[0].x).toEqual(100);
    expect(counted.matchingItems[0].y).toEqual(160);
    expect(counted.matchingItems.every(i => i.id !== 'low1')).toBe(true);
    expect(counted.unresolvedItems?.some(i => i.id === 'low1')).toBe(true);
    expect(counted.truncated).toBeUndefined();
    expect(counted.omittedItems).toBe(0);
  });

  it('45 matching + 45 unresolved is not truncated', () => {
    const items: DetectedItem[] = [];
    for (let i = 0; i < 45; i += 1) {
      items.push({
        id: `ok-${i}`,
        type: 'A',
        trade: 'electrical',
        name: 'A',
        quantity: 1,
        location: { x: 10, y: 10 },
        confidence: 0.9,
        legendTypeCode: 'A',
        matchConfidence: 'high',
      });
    }
    for (let i = 0; i < 45; i += 1) {
      items.push({
        id: `low-${i}`,
        type: 'B',
        trade: 'electrical',
        name: 'B',
        quantity: 1,
        location: { x: 20, y: 20 },
        confidence: 0.4,
        legendTypeCode: 'B',
        matchConfidence: 'low',
      });
    }
    const counted = countItemsFromAnalysis({
      page: 1,
      items,
      dimensions: [],
      text: [],
      symbols: [],
      legendTypeCounts: { A: 45, B: 0 },
    }, '', { pageWidth: 612, pageHeight: 792 });
    expect(counted.matchingItems).toHaveLength(45);
    expect(counted.unresolvedItems).toHaveLength(45);
    expect(counted.truncated).toBeFalsy();
    expect(counted.omittedItems).toBe(0);
  });

  it('320 items stay under 12k after the safety pass and paging returns the remainder', async () => {
    const { sanitizeToolOutput } = await import('../agent/safety');
    const items: DetectedItem[] = Array.from({ length: 320 }, (_, i) => ({
      id: `item-${i}`,
      type: 'A',
      trade: 'electrical' as const,
      name: 'A',
      quantity: 1,
      location: { x: 10 + (i % 40), y: 12 + (i % 30) },
      confidence: 0.9,
      legendTypeCode: 'A',
      matchConfidence: 'high' as const,
    }));
    const counted = countItemsFromAnalysis({
      page: 1,
      items,
      dimensions: [],
      text: [],
      symbols: [],
      legendTypeCounts: { A: 320 },
    }, '', { pageWidth: 612, pageHeight: 792 });
    expect(counted.truncated).toBe(true);
    expect(counted.omittedItems).toBe(320 - counted.matchingItems.length);
    expect(counted.matchingItems.length).toBeGreaterThan(0);
    const sanitized = sanitizeToolOutput(counted);
    expect(sanitized).not.toHaveProperty('preview');
    const serialized = JSON.stringify(sanitized);
    expect(serialized.length).toBeLessThan(12_000);
    expect(() => JSON.parse(serialized)).not.toThrow();

    const page2 = countItemsFromAnalysis({
      page: 1,
      items,
      dimensions: [],
      text: [],
      symbols: [],
      legendTypeCounts: { A: 320 },
    }, '', { pageWidth: 612, pageHeight: 792, offset: counted.nextOffset });
    expect(page2.matchingItems[0].id).not.toBe(counted.matchingItems[0].id);
    const returnedIds = new Set([
      ...counted.matchingItems.map(r => r.id),
      ...page2.matchingItems.map(r => r.id),
    ]);
    expect(returnedIds.size).toBe(counted.matchingItems.length + page2.matchingItems.length);
  });

  it('pages unresolved items so every unresolved id is reachable exactly once', () => {
    const items: DetectedItem[] = Array.from({ length: 320 }, (_, i) => ({
      id: `low-${i}`,
      type: 'B',
      trade: 'electrical' as const,
      name: 'B',
      quantity: 1,
      location: { x: 10, y: 10 },
      confidence: 0.4,
      legendTypeCode: 'B',
      matchConfidence: 'low' as const,
    }));
    const seen = new Set<string>();
    let offset = 0;
    let section: 'matching' | 'unresolved' = 'matching';
    let pages = 0;
    while (pages < 20) {
      const counted = countItemsFromAnalysis({
        page: 1,
        items,
        dimensions: [],
        text: [],
        symbols: [],
        legendTypeCounts: { B: 0 },
      }, '', { pageWidth: 612, pageHeight: 792, offset, section });
      for (const row of counted.unresolvedItems || []) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      if (counted.hasMoreUnresolved && counted.nextUnresolvedOffset != null) {
        section = 'unresolved';
        offset = counted.nextUnresolvedOffset;
        pages += 1;
        continue;
      }
      break;
    }
    expect(seen.size).toBe(320);
    expect([...seen].sort()).toEqual(items.map(item => item.id).sort());
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
