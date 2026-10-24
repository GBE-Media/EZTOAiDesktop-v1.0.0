import '../agent/testGlobals';
import { describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { clearIndexMemory, allIndexedPages, projectIndexDb } from './store';

function fakePdf(fp: string, numPages: number, onGetPage: (n: number) => void, delayMs = 0) {
  return {
    numPages, fingerprints: [fp], getPageLabels: async () => null,
    getPage: async (n: number) => {
      onGetPage(n);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      return { getViewport: () => ({ width: 612, height: 792 }), getTextContent: async () => ({ items: [{ str: `page ${n} text ZETA${n}`, transform: [10, 0, 0, 10, 72, 700], width: 60, height: 10 }] }) };
    },
  };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('ROUND2 scheduler B2/B3', () => {
  it('close aborts mid-index, closed doc not served, reopen (new docId, same fp) is indexed + rebound, busy pauses', async () => {
    clearIndexMemory();
    await projectIndexDb.pages.clear().catch(() => undefined);
    const calls = { big: 0 };
    const canvas = useCanvasStore.getState();
    canvas.setPdfDocument('big-1', fakePdf('fpBIG', 200, () => { calls.big++; }, 5) as never, 200, 612, 792);
    const { startProjectIndexer, resetProjectIndexerForTests } = await import('./scheduler');
    resetProjectIndexerForTests();
    startProjectIndexer();
    await sleep(500);
    const before = calls.big;
    useCanvasStore.getState().removeDocument('big-1');
    if (useCanvasStore.getState().pdfDocuments['big-1']) {
      useCanvasStore.setState(s => { const n = { ...s.pdfDocuments }; delete n['big-1']; return { pdfDocuments: n }; });
    }
    await sleep(800);
    const afterClose = calls.big;
    await sleep(600);
    const stillAfter = calls.big;
    const served = allIndexedPages().filter(p => p.docId === 'big-1').length;
    console.log('[R2] abort: getPage before close', before, 'right after', afterClose, '600ms later', stillAfter, 'served for closed id', served);
    // wait for the closed doc's run to finish so the rest of the scenario is independent
    for (let i = 0; i < 40 && allIndexedPages().some(p => p.docId === 'big-1'); i++) await sleep(250);
    const abortOk = stillAfter === afterClose && served === 0;

    // busy pause
    useCanvasStore.setState({ editorInteractionBusy: true } as never);
    const small = { n: 0 };
    useCanvasStore.getState().setPdfDocument('small-1', fakePdf('fpSMALL', 3, () => { small.n++; }) as never, 3, 612, 792);
    await sleep(800);
    const whileBusy = small.n;
    useCanvasStore.setState({ editorInteractionBusy: false } as never);
    await sleep(1200);
    console.log('[R2] busy: getPage while busy', whileBusy, 'after release', small.n);
    expect(whileBusy).toBe(0);

    // reopen same fingerprint under a new id
    useCanvasStore.setState(s => { const n = { ...s.pdfDocuments }; delete n['small-1']; return { pdfDocuments: n }; });
    await sleep(600);
    const re = { n: 0 };
    useCanvasStore.getState().setPdfDocument('small-2', fakePdf('fpSMALL', 3, () => { re.n++; }) as never, 3, 612, 792);
    await sleep(1500);
    const ids = new Set(allIndexedPages().map(p => p.docId));
    console.log('[R2] reopen: ids served', [...ids], 'getPage calls on reopen (0 = cache hit)', re.n, 'rows for small-2', allIndexedPages().filter(p => p.docId === 'small-2').length);
    expect(ids.has('small-2')).toBe(true);
    expect(ids.has('small-1')).toBe(false);
    expect(allIndexedPages().filter(p => p.docId === 'small-2').length).toBe(3);
    resetProjectIndexerForTests();
    expect(abortOk).toBe(true);
  }, 40_000);
});
