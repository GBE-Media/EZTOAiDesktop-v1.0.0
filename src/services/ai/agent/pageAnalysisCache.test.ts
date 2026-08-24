import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { createAgentToolContext } from './createToolContext';
import { executeAssistantTool } from '../tools/registry';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from './tools/registerAll';
import {
  clearPageAnalysisCache,
  countItemsFromAnalysis,
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
    expect(summarizeCachedPageAnalyses('doc-vision')).toMatch(/page 1/);
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
  });

  it('countItemsFromAnalysis matches fixture-style queries', () => {
    const result = countItemsFromAnalysis(analysisFixture(), 'light');
    expect(result.total).toBe(2);
    expect(result.matchingTypeCounts).toEqual({ light: 2 });
  });

  it('routing prefers count_page_items for counting requests', () => {
    const intake = runIntake({
      userMessage: 'Yes, please help with counting the lights on the lighting plan',
      userIntent: 'Yes, please help with counting the lights on the lighting plan',
      trade: 'electrical',
    });
    const decision = decideRoutingPolicy(intake);
    expect(decision.path).toBe('invoke_primary');
    expect(decision.suggestedTools).toEqual(
      expect.arrayContaining(['count_page_items', 'analyze_page']),
    );
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
