import { useCanvasStore } from '@/store/canvasStore';
import type { ApprovalRequest } from '@/types/assistant';
import { resolveDocumentRef } from '../documentRef';

export type ApprovalTarget = {
  docId: string;
  page: number;
  pageWidth: number;
  pageHeight: number;
};

/**
 * Which document/page a place_markups / propose_callouts approval targets, with
 * that page's own dimensions (never the active doc's), so preview and placement
 * agree for cross-document approvals.
 */
export function resolveApprovalTarget(
  approval: ApprovalRequest,
  fallback: { pageWidth: number; pageHeight: number },
): ApprovalTarget | { error: string } {
  const canvas = useCanvasStore.getState();
  const payload = approval.payload && typeof approval.payload === 'object'
    ? approval.payload as { documentId?: string; page?: number; analysisRef?: { docId?: string; page?: number } }
    : {};
  const resolved = resolveDocumentRef(payload.documentId || payload.analysisRef?.docId);
  if ('error' in resolved) return { error: resolved.error };
  const pdf = canvas.pdfDocuments[resolved.docId];
  const page = payload.page || payload.analysisRef?.page || pdf?.currentPage || canvas.getCurrentPage() || 1;
  return {
    docId: resolved.docId,
    page,
    pageWidth: pdf?.originalPageWidth || fallback.pageWidth,
    pageHeight: pdf?.originalPageHeight || fallback.pageHeight,
  };
}
