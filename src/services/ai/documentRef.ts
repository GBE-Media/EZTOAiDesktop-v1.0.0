import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { allIndexedPages } from './projectIndex/store';

export type DocumentRefHow = 'id' | 'name' | 'code' | 'index' | 'active';

export type ResolveDocumentRefResult =
  | { docId: string; how: DocumentRefHow }
  | { error: string };

export function listOpenDocuments(): Array<{ id: string; name: string }> {
  const editor = useEditorStore.getState();
  const canvas = useCanvasStore.getState();
  const rows: Array<{ id: string; name: string }> = editor.documents.map(doc => ({
    id: doc.id,
    name: doc.name,
  }));
  const seen = new Set(rows.map(row => row.id));
  for (const id of Object.keys(canvas.pdfDocuments)) {
    if (seen.has(id)) continue;
    rows.push({ id, name: id });
  }
  return rows;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.\\/]+$/, '');
}

function bracketCode(name: string): string | null {
  const match = name.trim().match(/^\[([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

function formatValidPairs(docs: Array<{ id: string; name: string }>): string {
  if (!docs.length) return 'No documents are open.';
  return docs.map(doc => `${doc.id} — ${doc.name}`).join('; ');
}

export function formatUnknownDocumentError(ref?: string): string {
  const docs = listOpenDocuments();
  const pairs = formatValidPairs(docs);
  const asked = ref?.trim() ? `Unknown documentId ${ref.trim()}. ` : 'Unknown documentId. ';
  return `${asked}Valid documents: ${pairs}`;
}

export function resolveDocumentRef(ref?: string): ResolveDocumentRefResult {
  const docs = listOpenDocuments();
  const canvas = useCanvasStore.getState();
  const active = canvas.activeDocId;

  if (!ref || !String(ref).trim()) {
    if (active && canvas.pdfDocuments[active]) return { docId: active, how: 'active' };
    if (docs.length === 1) return { docId: docs[0].id, how: 'active' };
    return { error: formatUnknownDocumentError(ref) };
  }

  const q = String(ref).trim();
  const lower = q.toLowerCase();

  if (docs.some(doc => doc.id === q) || canvas.pdfDocuments[q]) {
    return { docId: q, how: 'id' };
  }

  const byName = docs.filter(doc => {
    const name = doc.name.toLowerCase();
    const stem = stripExtension(doc.name).toLowerCase();
    const queryStem = stripExtension(q).toLowerCase();
    return name === lower || stem === lower || stem === queryStem;
  });
  if (byName.length === 1) return { docId: byName[0].id, how: 'name' };
  if (byName.length > 1) return { error: formatUnknownDocumentError(q) };

  const byCode = docs.filter(doc => {
    const code = bracketCode(doc.name);
    if (!code) return false;
    const codeLower = code.toLowerCase();
    return codeLower === lower || lower === `[${codeLower}]`;
  });
  if (byCode.length === 1) return { docId: byCode[0].id, how: 'code' };
  if (byCode.length > 1) return { error: formatUnknownDocumentError(q) };

  const sheetHits = allIndexedPages().filter(page =>
    page.sheetNumber && page.sheetNumber.toLowerCase() === lower,
  );
  const sheetDocs = [...new Set(sheetHits.map(page => page.docId).filter(id =>
    docs.some(doc => doc.id === id) || canvas.pdfDocuments[id],
  ))];
  if (sheetDocs.length === 1) return { docId: sheetDocs[0], how: 'index' };
  if (sheetDocs.length > 1) return { error: formatUnknownDocumentError(q) };

  if (/^\d+$/.test(q)) {
    const tab = Number(q);
    if (tab >= 1 && tab <= docs.length) {
      return { docId: docs[tab - 1].id, how: 'index' };
    }
    return { error: formatUnknownDocumentError(q) };
  }

  if (q.length >= 3) {
    const bySubstring = docs.filter(doc =>
      doc.name.toLowerCase().includes(lower) || doc.id.toLowerCase().includes(lower),
    );
    if (bySubstring.length === 1) return { docId: bySubstring[0].id, how: 'name' };
  }

  // An explicit ref that matches nothing must fail (with the valid list) so the
  // model self-corrects — never silently retarget another document.
  return { error: formatUnknownDocumentError(q) };
}

/** Compact "which doc did we use" note for tool outputs. */
export function describeResolvedDocument(ref: string | undefined, resolved: { docId: string; how: DocumentRefHow }) {
  const doc = listOpenDocuments().find(row => row.id === resolved.docId);
  return { documentId: resolved.docId, name: doc?.name || resolved.docId, how: resolved.how, requested: ref || null };
}

export function resolveOrFail(ref?: string): { docId: string; how: DocumentRefHow } | { error: string } {
  return resolveDocumentRef(ref);
}
