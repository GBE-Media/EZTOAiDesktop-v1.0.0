import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { createAgentToolContext } from './createToolContext';
import { executeAssistantTool } from '../tools/registry';

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

function seedOpenPdf(options?: { totalPages?: number }) {
  const totalPages = options?.totalPages ?? 3;
  useCanvasStore.getState().setPdfDocument('doc-vision', fakePdfDoc, totalPages, 612, 792);
  useCanvasStore.getState().clearAiSelection();
  useCanvasStore.getState().clearAiViewport();
}

function clearPdf() {
  useCanvasStore.getState().clearAllDocuments();
  useCanvasStore.getState().clearAiSelection();
  useCanvasStore.getState().clearAiViewport();
}

/** Mirrors AiChatDrawer createEditorToolContext (sites 1–3). */
function editorStyleContext(runId: string, messageId: string) {
  return createAgentToolContext({
    runId,
    messageId,
    trade: 'electrical',
    placeMarkups: () => ({ placed: 0 }),
    navigateToPage: () => undefined,
  });
}

/** Mirrors AiChatDrawer site 4 (approval executeApprovedAssistantAction). */
function approvalExecuteContext(runId: string, messageId: string) {
  return createAgentToolContext({
    runId,
    messageId,
    trade: 'electrical',
    placeMarkups: () => ({ placed: 0 }),
  });
}

describe('createAgentToolContext vision defaults (Phase 3)', () => {
  beforeEach(() => {
    analyzePageMaximumAccuracyMock.mockReset();
    extractPageTextEvidenceMock.mockReset();
    clearPdf();

    analyzePageMaximumAccuracyMock.mockResolvedValue({
      overviewImage: 'data:image/jpeg;base64,HUGE_SHOULD_BE_STRIPPED',
      textEvidence: {
        source: 'native',
        confidence: 1,
        context: 'FIXTURE SCHEDULE A-1',
        items: [{ str: 'FIXTURE', x: 10, y: 20, width: 40, height: 12 }],
      },
      analysis: {
        page: 2,
        items: [{
          id: 'item-1',
          type: 'receptacle',
          trade: 'electrical',
          name: 'Duplex',
          quantity: 1,
          location: { x: 100, y: 200 },
          confidence: 0.95,
        }],
        dimensions: [],
        text: [],
        symbols: [],
        typeCounts: { receptacle: 1 },
        evidence: ['Sheet E-101'],
      },
    });

    extractPageTextEvidenceMock.mockResolvedValue({
      source: 'native',
      confidence: 1,
      context: 'PANEL SCHEDULE\nLP-1 100A',
      items: [
        { str: 'PANEL', x: 50, y: 60, width: 40, height: 10 },
        { str: 'SCHEDULE', x: 95, y: 60, width: 55, height: 10 },
      ],
    });
  });

  it('analyze_page default calls analyzePageMaximumAccuracy for all 4 AiChatDrawer context shapes', async () => {
    seedOpenPdf();

    const contexts = [
      editorStyleContext('run-start', 'msg-start'),       // site 1: agent start
      editorStyleContext('run-approval', 'msg-approval'), // site 2: resume after approval
      editorStyleContext('run-clarify', 'msg-clarify'),   // site 3: clarification resume
      approvalExecuteContext('run-exec', 'msg-exec'),     // site 4: approved action execute
    ];

    for (const [index, context] of contexts.entries()) {
      analyzePageMaximumAccuracyMock.mockClear();
      const output = await context.analyzePage({ page: 2, scope: 'full', prompt: 'count receptacles' }) as {
        status: string;
        analysis?: { page: number; typeCounts?: Record<string, number> };
        textEvidence?: { context: string; itemCount: number };
        overviewImage?: unknown;
      };

      expect(output.status, `site ${index + 1}`).toBe('completed');
      expect(output.overviewImage, `site ${index + 1} must omit overviewImage`).toBeUndefined();
      expect(output.analysis).toMatchObject({ page: 2, typeCounts: { receptacle: 1 } });
      expect(output.textEvidence).toMatchObject({
        context: 'FIXTURE SCHEDULE A-1',
        itemCount: 1,
      });
      expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledTimes(1);
      expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledWith(expect.objectContaining({
        pdfDoc: fakePdfDoc,
        page: 2,
        pageWidth: 612,
        pageHeight: 792,
        trade: 'electrical',
        userPrompt: 'count receptacles',
        analysisRegion: undefined,
      }));
    }
  });

  it('analyze_page via registry uses the shared default (not the old unavailable stub)', async () => {
    seedOpenPdf();
    const context = editorStyleContext('run-reg', 'msg-reg');
    const result = await executeAssistantTool('analyze_page', { page: 1, scope: 'full' }, context);
    expect(result.status).toBe('completed');
    expect(result.output).toMatchObject({ status: 'completed', page: 1 });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalled();
    expect(result.output).not.toMatchObject({
      message: expect.stringContaining('Pass analyzePage adapter'),
    });
  });

  it('returns unavailable for viewport/selection when no region is set (no silent full-page fallback)', async () => {
    seedOpenPdf();
    const context = editorStyleContext('run-scope', 'msg-scope');

    const selection = await context.analyzePage({ page: 1, scope: 'selection' }) as {
      status: string;
      message?: string;
    };
    expect(selection).toEqual({
      status: 'unavailable',
      message: 'Select a region on the canvas before analyzing with scope "selection".',
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();

    const viewport = await context.analyzePage({ page: 1, scope: 'viewport' }) as {
      status: string;
      message?: string;
    };
    expect(viewport).toEqual({
      status: 'unavailable',
      message: 'Unable to determine the visible viewport for scope "viewport". Try zooming or fit-to-canvas and retry.',
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();
  });

  it('passes analysisRegion when selection/viewport rects exist', async () => {
    seedOpenPdf();
    const canvas = useCanvasStore.getState();
    canvas.setAiSelectionRect('doc-vision', 1, { x: 10, y: 20, width: 100, height: 50 });
    canvas.setAiViewportRect('doc-vision', 2, { x: 0, y: 0, width: 300, height: 200 });

    const context = editorStyleContext('run-region', 'msg-region');

    await context.analyzePage({ page: 1, scope: 'selection' });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledWith(expect.objectContaining({
      page: 1,
      analysisRegion: { x: 10, y: 20, width: 100, height: 50 },
    }));

    analyzePageMaximumAccuracyMock.mockClear();
    await context.analyzePage({ page: 2, scope: 'viewport' });
    expect(analyzePageMaximumAccuracyMock).toHaveBeenCalledWith(expect.objectContaining({
      page: 2,
      analysisRegion: { x: 0, y: 0, width: 300, height: 200 },
    }));
  });

  it('returns unavailable for zero-area viewport/selection regions without calling the pipeline', async () => {
    seedOpenPdf();
    const canvas = useCanvasStore.getState();
    const context = editorStyleContext('run-zero', 'msg-zero');

    canvas.setAiViewportRect('doc-vision', 1, { x: 10, y: 20, width: 0, height: 100 });
    const zeroWidth = await context.analyzePage({ page: 1, scope: 'viewport' });
    expect(zeroWidth).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('no usable area'),
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();

    analyzePageMaximumAccuracyMock.mockClear();
    canvas.setAiViewportRect('doc-vision', 1, { x: 10, y: 20, width: 100, height: 0 });
    const zeroHeight = await context.analyzePage({ page: 1, scope: 'viewport' });
    expect(zeroHeight).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('no usable area'),
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();

    analyzePageMaximumAccuracyMock.mockClear();
    canvas.clearAiViewport();
    canvas.setAiSelectionRect('doc-vision', 1, { x: 50, y: 50, width: 0, height: 0 });
    const zeroSelection = await context.analyzePage({ page: 1, scope: 'selection' });
    expect(zeroSelection).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('no usable area'),
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();
  });

  it('rejects off-page and sub-1pt overlap regions after true page intersection', async () => {
    seedOpenPdf(); // page 612 x 792
    const canvas = useCanvasStore.getState();
    const context = editorStyleContext('run-offpage', 'msg-offpage');

    // Entirely left of the page — must not be shifted on-page with original width.
    canvas.setAiViewportRect('doc-vision', 1, { x: -50, y: 20, width: 20, height: 100 });
    expect(await context.analyzePage({ page: 1, scope: 'viewport' })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('no usable area'),
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();

    analyzePageMaximumAccuracyMock.mockClear();
    // Sub-1pt overlap after intersection (x=-0.5..0.5 → clamped width 0.5)
    canvas.setAiSelectionRect('doc-vision', 1, { x: -0.5, y: 100, width: 1, height: 50 });
    expect(await context.analyzePage({ page: 1, scope: 'selection' })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('no usable area'),
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();
  });

  it('analyze_page returns unavailable with no PDF or out-of-range page', async () => {
    const context = editorStyleContext('run-miss', 'msg-miss');
    expect(await context.analyzePage({ page: 1, scope: 'full' })).toEqual({
      status: 'unavailable',
      message: 'No PDF document is open for page analysis.',
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();

    seedOpenPdf({ totalPages: 2 });
    expect(await context.analyzePage({ page: 9, scope: 'full' })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('out of range'),
    });
    expect(analyzePageMaximumAccuracyMock).not.toHaveBeenCalled();
  });

  it('extract_page_text returns real text-layer content from extractPageTextEvidence', async () => {
    seedOpenPdf();
    const context = editorStyleContext('run-text', 'msg-text');

    const output = await context.extractPageText({ page: 1 }) as {
      status: string;
      source: string;
      context: string;
      itemCount: number;
      items: unknown[];
    };

    expect(output).toMatchObject({
      status: 'completed',
      page: 1,
      source: 'native',
      confidence: 1,
      context: 'PANEL SCHEDULE\nLP-1 100A',
      itemCount: 2,
    });
    expect(output.items).toHaveLength(2);
    expect(extractPageTextEvidenceMock).toHaveBeenCalledWith(
      fakePdfDoc,
      1,
      612,
      792,
      expect.any(Function),
      expect.any(Function),
    );

    const viaRegistry = await executeAssistantTool('extract_page_text', { page: 1 }, context);
    expect(viaRegistry.status).toBe('completed');
    expect(viaRegistry.output).toMatchObject({ status: 'completed', context: 'PANEL SCHEDULE\nLP-1 100A' });
  });

  it('extract_page_text returns OCR-backed evidence when the pipeline reports ocr', async () => {
    seedOpenPdf();
    extractPageTextEvidenceMock.mockResolvedValueOnce({
      source: 'ocr',
      confidence: 0.82,
      context: 'SCANNED NOTES',
      items: [{ str: 'SCANNED', x: 1, y: 2, width: 3, height: 4 }],
    });

    const output = await editorStyleContext('run-ocr', 'msg-ocr').extractPageText({ page: 2 });
    expect(output).toMatchObject({
      status: 'completed',
      source: 'ocr',
      confidence: 0.82,
      context: 'SCANNED NOTES',
      itemCount: 1,
    });
  });

  it('extract_page_text returns unavailable with no PDF or bad page', async () => {
    const context = editorStyleContext('run-text-miss', 'msg-text-miss');
    expect(await context.extractPageText({ page: 1 })).toEqual({
      status: 'unavailable',
      message: 'No PDF document is open for page text extraction.',
    });
    expect(extractPageTextEvidenceMock).not.toHaveBeenCalled();

    seedOpenPdf({ totalPages: 1 });
    expect(await context.extractPageText({ page: 4 })).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('out of range'),
    });
    expect(extractPageTextEvidenceMock).not.toHaveBeenCalled();
  });
});
