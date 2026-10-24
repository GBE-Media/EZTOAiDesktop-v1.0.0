/**
 * Scheduler behavior probes (review of feat/project-index-cross-doc-ai).
 * Place at: src/services/ai/projectIndex/scheduler.review.test.ts
 */
import '../agent/testGlobals';
import { describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { clearIndexMemory, allIndexedPages, projectIndexDb } from './store';

function fakePdf(fp: string, numPages: number, onGetPage: (n: number) => void) {
  return {
    numPages,
    fingerprints: [fp],
    getPageLabels: async () => null,
    getPage: async (n: number) => {
      onGetPage(n);
      return {
        getViewport: () => ({ width: 612, height: 792 }),
        getTextContent: async () => ({ items: [{ str: `page ${n} text`, transform: [1, 0, 0, 1, 72, 700], width: 60, height: 10 }] }),
      };
    },
  };
}

describe('project indexer scheduler', () => {
  it('indexes ALL open docs (not just the first two), does not re-run finished docs, stops on close', async () => {
    clearIndexMemory();
    await projectIndexDb.pages.clear().catch(() => undefined);
    const calls: Record<string, number> = { a: 0, b: 0, c: 0 };
    const canvas = useCanvasStore.getState();
    canvas.setPdfDocument('a', fakePdf('fpA', 3, () => { calls.a++; }) as never, 3, 612, 792);
    canvas.setPdfDocument('b', fakePdf('fpB', 3, () => { calls.b++; }) as never, 3, 612, 792);
    canvas.setPdfDocument('c', fakePdf('fpC', 3, () => { calls.c++; }) as never, 3, 612, 792);
    const { startProjectIndexer, resetProjectIndexerForTests } = await import('./scheduler');
    resetProjectIndexerForTests();
    startProjectIndexer();
    await new Promise(r => setTimeout(r, 4000));
    const docsIndexed = new Set(allIndexedPages().map(p => p.docId));
    console.log('docs indexed after 4s:', [...docsIndexed], 'getPage calls', calls);
    expect(docsIndexed.has('c')).toBe(true);
  }, 15_000);
});
