import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { indexPdfDocument } from './indexPages';
import { allIndexedPages, dropIndexedDocument } from './store';
import { useIndexProgressStore } from './indexProgress';

const inflight = new Map<string, AbortController>();
const done = new Set<string>();
let started = false;

export function resetProjectIndexerForTests(): void {
  started = false;
  done.clear();
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
}

export function startProjectIndexer(): void {
  if (started) return;
  started = true;
  void tick();
}

async function tick(): Promise<void> {
  if (!started) return;
  const canvas = useCanvasStore.getState();
  const openIds = new Set(Object.keys(canvas.pdfDocuments));
  for (const id of [...done]) {
    if (!openIds.has(id)) done.delete(id);
  }
  for (const id of inflight.keys()) {
    if (!openIds.has(id)) {
      inflight.get(id)?.abort();
      inflight.delete(id);
      dropIndexedDocument(id);
      useIndexProgressStore.getState().clearDoc(id);
    }
  }
  for (const id of [...(allIndexedPages().map(p => p.docId))]) {
    if (!openIds.has(id)) dropIndexedDocument(id);
  }
  if (canvas.editorInteractionBusy) {
    setTimeout(() => void tick(), 250);
    return;
  }
  const editor = useEditorStore.getState();
  const queued = [...openIds].filter(id => !inflight.has(id) && !done.has(id)).slice(0, 2);
  await Promise.all(queued.map(id => indexOne(id, editor.documents.find(d => d.id === id)?.name || id)));
  setTimeout(() => void tick(), 250);
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
      signal: controller.signal,
      isBusy: () => useCanvasStore.getState().editorInteractionBusy,
    });
    if (!controller.signal.aborted) done.add(docId);
  } catch {
    /* closed or cancelled */
  } finally {
    inflight.delete(docId);
  }
}

export function requestOcrOnScannedPages(): { queued: number } {
  return { queued: 0 };
}
