import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { createAgentToolContext } from './createToolContext';
import { executeAssistantTool } from '../tools/registry';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from './tools/registerAll';
import {
  clearPageAnalysisCache,
  countItemsFromAnalysis,
  hasLatestFullPageAnalysis,
  summarizeCachedPageAnalyses,
} from './pageAnalysisCache';
import { buildMaxStepsAssistantMessage } from './runnerCore';
import type { AgentSessionState } from './types';
import { decideRoutingPolicy } from './routing/policy';
import { runIntake } from './phases/intake';
import type { BlueprintAnalysisResult } from '../providers/types';

const analyzePageMaximumAccuracyMock = vi.hoisted(() => vi.fn());
const extractPageTextEvidenceMock = vi.hoisted(() => vi.fn());

vi.mock('../pipeline', async importOriginal => {
  const actual = await importOriginal<typeof import('../pipeline')>();
  return {
    ...actual,
    analyzePageMaximumAccuracy: analyzePageMaximumAccuracyMock,
    extractPageTextEvidence: extractPageTextEvidenceMock,
  };
});

const fakePdfDoc = { _isFakePdf: true };

function seedOpenPdf() {
  useCanvasStore.getState().setPdfDocument('doc-vision', fakePdfDoc, 2, 612, 792);
}

function analysisFixture(overrides?: Partial<BlueprintAnalysisResult>): BlueprintAnalysisResult {
  return {
    page: 1,
    items: [
      {
        id: 'l1',
        type: 'light',
        trade: 'electrical',
        name: 'Type A fixture',
        quantity: 1,
        location: { x: 10, y: 20 },
        confidence: 0.9,
      },
      {
        id: 'l2',
        type: 'light',
        trade: 'electrical',
        name: 'Type A fixture',
        quantity: 1,
        location: { x: 30, y: 40 },
        confidence: 0.9,
      },
      {
        id: 'r1',
        type: 'receptacle',
        trade: 'electrical',
        name: 'Duplex',
        quantity: 1,
        location: { x: 50, y: 60 },
        confidence: 0.85,
      },
    ],
    dimensions: [],
    text: [],
    symbols: [],
    typeCounts: { light: 2, receptacle: 1 },
    ...overrides,
  };
}

describe('page analysis cache + count_page_items', () => {
  beforeEach(() => {
    analyzePageMaximumAccuracyMock.mockReset();
    extractPageTextEvidenceMock.mockReset();
    clearPageAnalysisCache();
    useCanvasStore.getState().clearAllDocuments();
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();

    analyzePageMaximumAccuracyMock.mockResolvedValue({
      overviewImage: 'data:image/jpeg;base64,IGNORED',
      textEvidence: {
        source: 'native',
        confidence: 1,
        context: 'LIGHTING PLAN',
        items: [{ str: 'LIGHT', x: 1, y: 2, width: 10, height: 8 }],
      },
      analysis: analysisFixture(),
    });

    extractPageTextEvidenceMock.mockResolvedValue({
      source: 'native',
      confidence: 1,
      context: 'LIGHTING PLAN',
      items: [{ str: 'LIGHT', x: 1, y: 2, width: 10, height: 8 }],
    });
  });

  it('analyze_page second call for the same page returns cache and skips vision', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-cache',
      messageId: 'msg-cache',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    const first = await context.analyzePage({ page: 1, scope: 'full' }) as {
      status: string;
      cached?: boolean;
      analysis?: { typeCounts?: Record<string, number> };
    };
    expect(first.status).toBe('completed');
    expect(first.cached).toBeUndefined();
    expect(first.analysis?.typeCounts).toEqual({ light: 2, receptacle: 1 });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);

    const second = await context.analyzePage({ page: 1, scope: 'full' }) as {
      status: string;
      cached?: boolean;
      cacheNote?: string;
    };
    expect(second.status).toBe('completed');
    expect(second.cached).toBe(true);
    expect(second.cacheNote).toMatch(/Do NOT re-call analyze_page/i);
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);

    const viaRegistry = await executeAssistantTool(
      'analyze_page',
      { page: 1, scope: 'full' },
      context,
    );
    expect(viaRegistry.output).toMatchObject({ cached: true, page: 1 });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
  });

  it('extract_page_text is cached per page', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-extract',
      messageId: 'msg-extract',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    await context.extractPageText({ page: 1 });
    await context.extractPageText({ page: 1 });
    expect(extractPageTextEvidenceMock).toHaveBeenCalledTimes(1);
  });

  it('count_page_items uses cached analysis without a second vision pass', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-count',
      messageId: 'msg-count',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    await context.analyzePage({ page: 1, scope: 'full' });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);

    const counted = await executeAssistantTool(
      'count_page_items',
      { page: 1, query: 'light' },
      context,
    );
    expect(counted.status).toBe('completed');
    expect(counted.output).toMatchObject({
      status: 'completed',
      source: 'cache',
      total: 2,
      query: 'light',
    });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
    const rev = useCanvasStore.getState().pdfDocuments['doc-vision']?.contentRevision;
    expect(summarizeCachedPageAnalyses('doc-vision', rev)).toMatch(/page 1/);
  });

  it('count_page_items runs one analyze when cache is empty then answers', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-count-fresh',
      messageId: 'msg-count-fresh',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    const counted = await context.countPageItems!({ page: 1, query: 'Type A' }) as {
      source: string;
      total: number;
      matchingItems: unknown[];
    };
    expect(counted.source).toBe('fresh_analysis');
    expect(counted.total).toBeGreaterThan(0);
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledWith(
      expect.objectContaining({ userPrompt: undefined }),
    );
  });

  it('replacing PDF under the same docId invalidates analyze cache (insert/delete/rotate)', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-invalidate',
      messageId: 'msg-invalidate',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    await context.analyzePage({ page: 1, scope: 'full' });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
    const revAfterLoad = useCanvasStore.getState().pdfDocuments['doc-vision']?.contentRevision;
    expect(revAfterLoad).toBeGreaterThan(0);

    // Simulate page insert/delete/rotate: updatePdfDocument keeps docId, bumps revision.
    useCanvasStore.getState().updatePdfDocument(
      'doc-vision',
      { _isFakePdf: true, afterMutation: true },
      3,
      612,
      792,
      new ArrayBuffer(8),
    );
    expect(useCanvasStore.getState().pdfDocuments['doc-vision']?.contentRevision).toBe(
      (revAfterLoad || 0) + 1,
    );
    const newRev = useCanvasStore.getState().pdfDocuments['doc-vision']?.contentRevision;
    expect(summarizeCachedPageAnalyses('doc-vision', newRev)).toBeUndefined();

    await context.analyzePage({ page: 1, scope: 'full' });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(2);
  });

  it('discards in-flight analyze results when document is edited before vision resolves', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-inflight-race',
      messageId: 'msg-inflight-race',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    const startedRevision = useCanvasStore.getState().pdfDocuments['doc-vision']!.contentRevision;
    let resolveVision!: (value: unknown) => void;
    const deferred = new Promise(resolve => {
      resolveVision = resolve;
    });
    analyzePageMaximumAccuracyMock.mockImplementationOnce(() => deferred);

    const inFlight = context.analyzePage({ page: 1, scope: 'full' });

    // Edit while vision is still pending — bumps revision and clears cache.
    useCanvasStore.getState().updatePdfDocument(
      'doc-vision',
      { _isFakePdf: true, afterInFlightEdit: true },
      3,
      612,
      792,
      new ArrayBuffer(8),
    );
    const newRevision = useCanvasStore.getState().pdfDocuments['doc-vision']!.contentRevision;
    expect(newRevision).toBe(startedRevision + 1);

    resolveVision({
      overviewImage: 'stale',
      textEvidence: { source: 'native', confidence: 1, context: 'STALE PRE-EDIT', items: [] },
      analysis: analysisFixture({
        items: analysisFixture().items.filter(i => i.type === 'light'),
        typeCounts: { light: 99 },
      }),
    });

    const staleResult = await inFlight as {
      status: string;
      discarded?: boolean;
      analysis?: { typeCounts?: Record<string, number> };
    };
    expect(staleResult.status).toBe('unavailable');
    expect(staleResult.discarded).toBe(true);
    expect(staleResult.analysis).toBeUndefined();

    // (a) stale result must not become canonical for the NEW revision
    expect(hasLatestFullPageAnalysis('doc-vision', 1, newRevision)).toBe(false);
    // nor for the old revision after clear+discard (should not re-poison)
    expect(hasLatestFullPageAnalysis('doc-vision', 1, startedRevision)).toBe(false);

    // (b) cross-turn summary must not advertise the pre-edit analysis
    expect(summarizeCachedPageAnalyses('doc-vision', newRevision)).toBeUndefined();
    expect(summarizeCachedPageAnalyses('doc-vision', startedRevision)).toBeUndefined();

    // (c) subsequent count must run a NEW vision call for the new revision
    analyzePageMaximumAccuracyMock.mockResolvedValue({
      overviewImage: 'fresh',
      textEvidence: { source: 'native', confidence: 1, context: 'POST-EDIT', items: [] },
      analysis: analysisFixture(),
    });
    const counted = await context.countPageItems!({ page: 1, query: 'light' }) as {
      source: string;
      total: number;
    };
    expect(counted.source).toBe('fresh_analysis');
    expect(counted.total).toBe(2);
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(2);
    expect(hasLatestFullPageAnalysis('doc-vision', 1, newRevision)).toBe(true);
    expect(summarizeCachedPageAnalyses('doc-vision', newRevision)).toMatch(/page 1/);
  });

  it('same docId + unchanged content still hits cache after a successful analyze', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-stable-cache',
      messageId: 'msg-stable-cache',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });
    await context.analyzePage({ page: 1, scope: 'full' });
    await context.analyzePage({ page: 1, scope: 'full' });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
  });

  it('second count_page_items for a different type reuses broad cache, not a query-biased manifest', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-count-broad',
      messageId: 'msg-count-broad',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    const first = await context.countPageItems!({ page: 1, query: 'Type A' }) as {
      source: string;
      total: number;
      allTypeCounts: Record<string, number>;
    };
    expect(first.source).toBe('fresh_analysis');
    expect(first.total).toBe(2);
    expect(first.allTypeCounts).toMatchObject({ light: 2, receptacle: 1 });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
    expect(analyzePageMaximumAccuracyMock.mock.calls[0][0].userPrompt).toBeUndefined();

    // If a second count wrongly re-ran vision (or used a fixtures-only biased cache),
    // swapping the mock to receptacles-only would change the answer. Cache must ignore this.
    analyzePageMaximumAccuracyMock.mockResolvedValue({
      overviewImage: 'data:image/jpeg;base64,IGNORED',
      textEvidence: {
        source: 'native',
        confidence: 1,
        context: 'SHOULD NOT BE USED',
        items: [],
      },
      analysis: analysisFixture({
        items: [{
          id: 'r-only',
          type: 'receptacle',
          trade: 'electrical',
          name: 'Duplex',
          quantity: 1,
          location: { x: 1, y: 1 },
          confidence: 0.9,
        }],
        typeCounts: { receptacle: 99 },
      }),
    });

    const second = await context.countPageItems!({ page: 1, query: 'receptacle' }) as {
      source: string;
      total: number;
    };
    expect(second.source).toBe('cache');
    expect(second.total).toBe(1);
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
  });

  it('prompt-targeted analyze_page is not promoted to latestFull for later counts', async () => {
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-no-promote',
      messageId: 'msg-no-promote',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    analyzePageMaximumAccuracyMock.mockResolvedValueOnce({
      overviewImage: 'ignored',
      textEvidence: { source: 'native', confidence: 1, context: 'biased', items: [] },
      analysis: analysisFixture({
        items: analysisFixture().items.filter(i => i.type === 'light'),
        typeCounts: { light: 2 },
      }),
    });

    await context.analyzePage({
      page: 1,
      scope: 'full',
      prompt: 'find Type A fixtures only',
    });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);

    analyzePageMaximumAccuracyMock.mockResolvedValueOnce({
      overviewImage: 'ignored',
      textEvidence: { source: 'native', confidence: 1, context: 'broad', items: [] },
      analysis: analysisFixture(),
    });

    const counted = await context.countPageItems!({ page: 1, query: 'receptacle' }) as {
      source: string;
      total: number;
    };
    expect(counted.source).toBe('fresh_analysis');
    expect(counted.total).toBe(1);
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(2);
    expect(analyzePageMaximumAccuracyMock.mock.calls[1][0].userPrompt).toBeUndefined();
  });

  it('count_page_items registry propagates unavailable adapter status', async () => {
    clearPdfDocumentsSafe();
    const context = createAgentToolContext({
      runId: 'run-unavailable',
      messageId: 'msg-unavailable',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });
    const result = await executeAssistantTool(
      'count_page_items',
      { page: 1, query: 'light' },
      context,
    );
    expect(result.status).toBe('failed');
    expect(result.output).toMatchObject({ status: 'unavailable' });
  });

  it('countItemsFromAnalysis matches fixture-style queries', () => {
    const result = countItemsFromAnalysis(analysisFixture(), 'light');
    expect(result.total).toBe(2);
    expect(result.matchingTypeCounts).toEqual({ light: 2 });
  });

  it('countItemsFromAnalysis surfaces legend reliability and verification notes to the model', () => {
    const analysis = {
      ...analysisFixture(),
      typeCounts: { A: 8, B: 4 },
      legendTypeCounts: { A: 8, 'A/EM/NL': 1, B: 3, 'B-NL': 1, B1: 4 },
      legendTypeCodes: ['A', 'A/EM/NL', 'B', 'B-NL', 'B1'],
      countReliability: 'partial' as const,
      countVerificationNotes: [
        'Legend-grounded using 5 type code(s) from this page: A, A/EM/NL, B, B-NL, B1',
        '1 detection(s) could not be matched to the page legend.',
        'Reliability: partial. Do not present per-type counts as final without review of flagged items.',
      ],
    };

    const result = countItemsFromAnalysis(analysis, '');
    expect(result.allTypeCounts).toEqual(analysis.legendTypeCounts);
    expect(result.countReliability).toBe('partial');
    expect(result.legendTypeCodes).toEqual(analysis.legendTypeCodes);
    expect(result.verificationNotes).toEqual(analysis.countVerificationNotes);
    expect(result.message).toMatch(/Count reliability: partial/i);
    expect(result.message).toMatch(/Legend-grounded types:/i);
    expect(result.message).toMatch(/could not be matched|Legend-grounded using/i);
    expect(result.message).not.toMatch(/No page legend types extracted/);
  });

  it('routing puts count_page_items first for counting requests', () => {
    const intake = runIntake({
      userMessage: 'Yes, please help with counting the lights on the lighting plan',
      userIntent: 'Yes, please help with counting the lights on the lighting plan',
      trade: 'electrical',
    });
    const decision = decideRoutingPolicy(intake);
    expect(decision.path).toBe('invoke_primary');
    expect(decision.preferTools).toBe(true);
    expect(decision.suggestedTools[0]).toBe('count_page_items');
    expect(decision.suggestedTools).toEqual(
      expect.arrayContaining(['count_page_items', 'analyze_page']),
    );
  });

  it('primary loop ROUTER_HINT for counting leads the model to invoke count_page_items first', async () => {
    const { runPrimaryAgentLoop, clearAgentSessionMemoryForTests, setAgentSession } = await import('./runnerCore');
    clearAgentSessionMemoryForTests();
    seedOpenPdf();
    const context = createAgentToolContext({
      runId: 'run-hint-count',
      messageId: 'msg-hint-count',
      trade: 'electrical',
      placeMarkups: () => ({ placed: 0 }),
    });

    let sawCountTool = false;
    const model = {
      complete: vi.fn(async ({ messages }: { messages: Array<{ role: string; content?: string; toolCalls?: unknown[] }> }) => {
        const hint = [...messages].reverse().find(m =>
          m.role === 'user' && typeof m.content === 'string' && m.content.includes('ROUTER_HINT'),
        );
        if (hint && typeof hint.content === 'string' && hint.content.includes('count_page_items')) {
          sawCountTool = true;
          return {
            type: 'tool_calls' as const,
            toolCalls: [{
              id: 'call_count_1',
              name: 'count_page_items',
              arguments: { page: 1, query: 'light' },
            }],
          };
        }
        return {
          type: 'final' as const,
          message: 'Counted from tools.',
          clarifyingQuestions: [],
        };
      }),
    };

    const session = {
      runId: 'run-hint-count',
      messageId: 'msg-hint-count',
      messages: [{ role: 'user' as const, content: 'Count the lights on the lighting plan' }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'ctx',
    };
    setAgentSession(session);

    const result = await runPrimaryAgentLoop({
      session,
      toolContext: context,
      model: model as never,
      maxSteps: 4,
      preferTools: true,
      suggestedTools: ['count_page_items', 'analyze_page', 'getTakeoffSummary'],
    });

    expect(sawCountTool).toBe(true);
    expect(result.actionsTaken.some(a => a.toolId === 'count_page_items')).toBe(true);
    expect(result.actionsTaken.some(a => a.toolId === 'analyze_page')).toBe(false);
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
    expect(analyzePageMaximumAccuracyMock.mock.calls[0][0].userPrompt).toBeUndefined();
  });

  it('max_steps message includes partial analyze findings when available', () => {
    const session = {
      runId: 'r1',
      messageId: 'm1',
      messages: [],
      toolHistory: [{
        id: 'th1',
        toolId: 'analyze_page',
        title: 'Analyze page',
        args: { page: 1 },
        result: {
          status: 'completed',
          summary: 'Analyzed page 1.',
          output: {
            status: 'completed',
            page: 1,
            analysis: analysisFixture(),
          },
        },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }],
      actionsTaken: [{
        toolId: 'analyze_page',
        title: 'Analyze page',
        summary: 'Analyzed page 1.',
        status: 'completed',
      }],
      contextText: '',
    } as AgentSessionState;

    const message = buildMaxStepsAssistantMessage(session);
    expect(message).toContain('maximum number of agent steps');
    expect(message).toContain('gathered so far');
    expect(message).toMatch(/light:\s*2/i);
  });
});

function clearPdfDocumentsSafe() {
  useCanvasStore.getState().clearAllDocuments();
}