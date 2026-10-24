import { useCanvasStore } from '@/store/canvasStore';

export function unknownDocumentResult(documentId?: string): { status: 'failed'; summary: string; output: { status: string; message: string } } | null {
  if (!documentId) return null;
  if (useCanvasStore.getState().pdfDocuments[documentId]) return null;
  const message = `Unknown documentId ${documentId}`;
  return { status: 'failed', summary: message, output: { status: 'failed', message } };
}

export function isUnknownDocumentId(documentId?: string): boolean {
  return !!documentId && !useCanvasStore.getState().pdfDocuments[documentId];
}
