import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { AssistantFocus, EvidenceCitation } from '@/types/assistant';
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

/** Navigate to an assistant focus (clarification / discrepancy). Unknown documents fall back to the active tab. */
export function openAssistantFocus(focus: AssistantFocus): boolean {
  const canvas = useCanvasStore.getState();
  const documentId = focus.documentId && canvas.pdfDocuments[focus.documentId] ? focus.documentId : canvas.activeDocId;
  if (!documentId) return false;
  const pageCount = canvas.pdfDocuments[documentId]?.totalPages;
  if (pageCount && focus.page > pageCount) return false;
  openEvidenceCitation({
    id: `focus_${documentId}_${focus.page}`,
    documentId,
    page: focus.page,
    bounds: focus.bounds,
    label: focus.label || `Page ${focus.page}`,
  } as EvidenceCitation);
  return true;
}
