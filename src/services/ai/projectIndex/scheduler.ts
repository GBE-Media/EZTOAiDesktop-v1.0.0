import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { indexPdfDocument } from './indexPages';
import { allIndexedPages } from './store';

const inflight = new Map<string, AbortController>();
let started = false;

export function startProjectIndexer(): void {
  if (started) return;
  started = true;
  void tick();
}

async function tick(): Promise<void> {
  const canvas = useCanvasStore.getState();
  if (canvas.editorInteractionBusy) {
    setTimeout(() => void tick(), 250);
    return;
  }
  const editor = useEditorStore.getState();
  const openIds = new Set(Object.keys(canvas.pdfDocuments));
  for (const id of inflight.keys()) {
    if (!openIds.has(id)) {
      inflight.get(id)?.abort();
      inflight.delete(id);
    }
  }
  const queued = [...openIds].filter(id => !inflight.has(id)).slice(0, 2);
  await Promise.all(queued.map(id => indexOne(id, editor.documents.find(d => d.id === id)?.name || id)));
  setTimeout(() => void tick(), 400);
}

async function indexOne(docId: string, name: string): Promise<void> {
  const controller = new AbortController();
  inflight.set(docId, controller);
  try {
    const pdf = useCanvasStore.getState().pdfDocuments[docId]?.pdfDocument;
    if (!pdf) return;
    await indexPdfDocument({
      docId,
      documentName: name,
      pdfDoc: pdf,
      yieldEveryPage: true,
    });
  } catch {
    /* closed or cancelled */
  } finally {
    inflight.delete(docId);
  }
}

export function requestOcrOnScannedPages(): { queued: number } {
  return { queued: allIndexedPages().filter(page => page.needsOcr).length };
}
