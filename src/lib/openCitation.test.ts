import { describe, expect, it, vi } from 'vitest';
import { citationChipText, openEvidenceCitation } from './openCitation';

const mocks = vi.hoisted(() => ({
  setActiveDocId: vi.fn(),
  setCurrentPage: vi.fn(),
  setAiSelectionRect: vi.fn(),
  setAiSelectionActive: vi.fn(),
  setActiveDocument: vi.fn(),
}));

vi.mock('@/store/canvasStore', () => ({
  useCanvasStore: {
    getState: () => ({
      activeDocId: 'doc-a',
      setActiveDocId: mocks.setActiveDocId,
      setCurrentPage: mocks.setCurrentPage,
      setAiSelectionRect: mocks.setAiSelectionRect,
      setAiSelectionActive: mocks.setAiSelectionActive,
    }),
  },
}));

vi.mock('@/store/editorStore', () => ({
  useEditorStore: {
    getState: () => ({
      setActiveDocument: mocks.setActiveDocument,
    }),
  },
}));

describe('citation chips', () => {
  it('search hit chip opens the doc, page, and highlight bounds', () => {
    const citation = {
      id: 'c1',
      documentId: 'doc-b',
      documentName: 'Drawings.pdf',
      page: 2,
      sheetNumber: 'E-100',
      label: 'Drawings.pdf · E-100',
      snippet: 'PANEL LP-2',
      bounds: { x: 10, y: 20, width: 40, height: 12 },
    };
    expect(citationChipText(citation)).toBe('Drawings.pdf · E-100');
    openEvidenceCitation(citation);
    expect(mocks.setActiveDocument).toHaveBeenCalledWith('doc-b');
    expect(mocks.setActiveDocId).toHaveBeenCalledWith('doc-b');
    expect(mocks.setCurrentPage).toHaveBeenCalledWith(2);
    expect(mocks.setAiSelectionRect).toHaveBeenCalledWith('doc-b', 2, citation.bounds);
    expect(mocks.setAiSelectionActive).toHaveBeenCalledWith(true);
  });
});
