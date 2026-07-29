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
          originalPdfBytes: null,
          textContentByPage: {},
          textWordsByPage: {},
          ocrStatus: 'none',
          ocrProgress: 0,
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
});
