import { resolveDocumentRef, formatUnknownDocumentError } from '../documentRef';

export function unknownDocumentResult(documentId?: string): { status: 'failed'; summary: string; output: { status: string; message: string } } | null {
  if (!documentId) return null;
  const resolved = resolveDocumentRef(documentId);
  if (!('error' in resolved)) return null;
  const message = resolved.error || formatUnknownDocumentError(documentId);
  return { status: 'failed', summary: message, output: { status: 'failed', message } };
}

export function isUnknownDocumentId(documentId?: string): boolean {
  if (!documentId) return false;
  return 'error' in resolveDocumentRef(documentId);
}

export function resolvedDocumentId(documentId?: string): string | undefined {
  const resolved = resolveDocumentRef(documentId);
  if ('error' in resolved) return undefined;
  return resolved.docId;
}
