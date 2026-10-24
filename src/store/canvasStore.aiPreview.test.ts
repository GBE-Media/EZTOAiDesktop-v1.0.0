import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from './canvasStore';
import type { CanvasMarkup } from '@/types/markup';

function marker(id: string, page: number): { page: number; markup: CanvasMarkup } {
  return {
    page,
    markup: {
      id,
      type: 'count-marker',
      page,
      x: 10,
      y: 10,
      style: { strokeColor: '#10b981', fillColor: '#10b981', strokeWidth: 1, opacity: 100 },
      locked: false,
      author: 'ai',
      createdAt: new Date().toISOString(),
      aiPending: true,
      number: 1,
      groupId: 'g1',
    } as CanvasMarkup,
  };
}

describe('aiPreview store', () => {
  beforeEach(() => {
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.getState().setPdfDocument('doc-1', { id: 'doc-1' }, 2, 612, 792);
  });

  it('never appears in markupsByPage', () => {
    useCanvasStore.getState().setAiPreview({
      approvalId: 'a1',
      docId: 'doc-1',
      markups: [marker('p1', 1)],
    });
    expect(useCanvasStore.getState().aiPreview?.markups).toHaveLength(1);
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1] || []).toHaveLength(0);
  });

  it('clears on reject/stop/close and approve places equal markups separately', () => {
    const preview = { approvalId: 'a1', docId: 'doc-1', markups: [marker('p1', 1), marker('p2', 1)] };
    useCanvasStore.getState().setAiPreview(preview);
    expect(useCanvasStore.getState().aiPreview?.markups).toHaveLength(2);
    useCanvasStore.getState().clearAiPreview();
    expect(useCanvasStore.getState().aiPreview).toBeNull();

    useCanvasStore.getState().setAiPreview(preview);
    useCanvasStore.getState().addAIMarkupBatch(preview.markups, false);
    useCanvasStore.getState().clearAiPreview();
    expect(useCanvasStore.getState().pdfDocuments['doc-1'].markupsByPage[1]).toHaveLength(2);
    expect(useCanvasStore.getState().aiPreview).toBeNull();
  });

  it('multi-page preview is stored per page for the overlay to filter', () => {
    useCanvasStore.getState().setAiPreview({
      approvalId: 'a2',
      docId: 'doc-1',
      markups: [marker('p1', 1), marker('p2', 2)],
    });
    const onPage1 = useCanvasStore.getState().aiPreview?.markups.filter(row => row.page === 1) || [];
    expect(onPage1).toHaveLength(1);
  });
});
