import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { EvidenceCitation } from '@/types/assistant';
import { formatCitationLabel } from '@/services/ai/projectIndex/summaries';

export function openEvidenceCitation(citation: EvidenceCitation): void {
  const canvas = useCanvasStore.getState();
  const editor = useEditorStore.getState();
  const documentId = citation.documentId || canvas.activeDocId;
  if (documentId) {
    editor.setActiveDocument(documentId);
    canvas.setActiveDocId(documentId);
  }
  canvas.setCurrentPage(citation.page);
  if (documentId && citation.bounds) {
    canvas.setAiSelectionRect(documentId, citation.page, citation.bounds);
    canvas.setAiSelectionActive(true);
  }
}

export function citationChipText(citation: EvidenceCitation): string {
  return formatCitationLabel({
    documentName: citation.documentName,
    sheetNumber: citation.sheetNumber,
    specSection: citation.specSection,
    page: citation.page,
    pageLabel: citation.pageLabel,
  }) || citation.label;
}
