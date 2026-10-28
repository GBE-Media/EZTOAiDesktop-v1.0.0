import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from './canvasStore';
import { useHistoryStore } from './historyStore';
import type { CanvasMarkup } from '@/types/markup';

const markup = (id: string, page: number): CanvasMarkup => ({
  id,
  type: 'rectangle',
  page,
  x: 10,
  y: 10,
  width: 20,
  height: 20,
  style: {
    strokeColor: '#10b981',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 1,
    fontSize: 12,
    fontFamily: 'Arial',
  },
  locked: false,
  author: 'test',
  createdAt: new Date().toISOString(),
});

describe('assistant batch history', () => {
  beforeEach(() => {
    useHistoryStore.getState().clearHistory();
    useCanvasStore.setState(state => ({
      ...state,
      activeDocId: 'doc-1',
      pdfDocuments: {
        'doc-1': {
          pdfDocument: null,
          totalPages: 2,
          currentPage: 1,
          zoom: 1,
          markupsByPage: { 1: [], 2: [] },
          originalPageWidth: 100,
          originalPageHeight: 100,
          panOffset: { x: 0, y: 0 },
          hasViewState: true,
          viewUserAdjusted: false,
          originalPdfBytes: null,
          textContentByPage: {},
          textWordsByPage: {},
          pageGeometryByPage: {},
          ocrStatus: 'none',
          ocrProgress: 0,
          contentRevision: 1,
        },
      },
    }));
  });

  it('undoes and redoes a multi-page AI batch as one transaction', () => {
    useCanvasStore.getState().addAIMarkupBatch([
      { page: 1, markup: markup('ai-1', 1) },
      { page: 2, markup: markup('ai-2', 2) },
    ], false);

    expect(useHistoryStore.getState().past).toHaveLength(1);
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[2]).toHaveLength(1);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1]).toHaveLength(0);
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[2]).toHaveLength(0);

    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1][0]).toMatchObject({
      id: 'ai-1',
      aiGenerated: true,
    });
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[2][0].id).toBe('ai-2');
  });

  it('replaces a run layout in one undo step while retaining user inputs', () => {
    const doc = useCanvasStore.getState().pdfDocuments['doc-1'];
    const old = markup('old-run', 1);
    const pin = { ...markup('user-panel', 1), locked: true };
    useCanvasStore.setState({ pdfDocuments: { 'doc-1': { ...doc, markupsByPage: { 1: [old, pin] } } } });
    const result = useCanvasStore.getState().addAIMarkupBatch([{ page: 1, markup: markup('new-run', 1) }], false, {
      documentId: 'doc-1', replaceIdsByPage: { 1: ['old-run'] },
    });
    expect(result.ok).toBe(true);
    expect(useHistoryStore.getState().past).toHaveLength(1);
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1].map(m => m.id)).toEqual(['user-panel', 'new-run']);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1]).toEqual([old, pin]);
    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1].map(m => m.id)).toEqual(['user-panel', 'new-run']);
  });

  it('does not remove old runs or redirect a batch when its source document is inactive', () => {
    const doc = useCanvasStore.getState().pdfDocuments['doc-1'];
    const old = markup('old-run', 1);
    useCanvasStore.setState({ activeDocId: 'other', pdfDocuments: {
      'doc-1': { ...doc, markupsByPage: { 1: [old] } }, other: { ...doc, markupsByPage: { 1: [] } },
    } });
    const result = useCanvasStore.getState().addAIMarkupBatch([{ page: 1, markup: markup('new-run', 1) }], false, {
      documentId: 'doc-1', replaceIdsByPage: { 1: ['old-run'] },
    });
    expect(result.ok).toBe(false);
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1]).toEqual([old]);
    expect(useCanvasStore.getState().pdfDocuments.other.markupsByPage[1]).toEqual([]);
    expect(useHistoryStore.getState().past).toHaveLength(0);
  });
});
