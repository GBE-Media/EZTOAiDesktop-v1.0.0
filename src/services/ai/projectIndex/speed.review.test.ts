import { perfBudget } from '@/test/perfBudget';
import '../agent/testGlobals';
import { expect, it } from 'vitest';
import { indexPdfDocument } from './indexPages';
import { clearIndexMemory, projectIndexDb } from './store';
function fakePdf(fp: string, numPages: number) {
  return { numPages, fingerprints: [fp], getPageLabels: async () => null,
    getPage: async (n: number) => ({ getViewport: () => ({ width: 612, height: 792 }),
      getTextContent: async () => ({ items: Array.from({ length: 45 }, (_, k) => ({ str: k === 0 ? 'SECTION 262726' : `A. Body text line ${k} wiring devices receptacles page ${n} requirement`, transform: [10, 0, 0, 10, 72, 740 - k * 15], width: 300, height: 10 })) }) }) };
}
it('scaling', async () => {
  for (const n of [150, 600]) {
    clearIndexMemory(); await projectIndexDb.pages.clear();
    let last = performance.now(); let maxB = 0; let run = true;
    const probe = () => { const now = performance.now(); maxB = Math.max(maxB, now - last); last = now; if (run) setTimeout(probe, 0); };
    setTimeout(probe, 0);
    const t0 = performance.now();
    await indexPdfDocument({ docId: 'd' + n, documentName: 'x', pdfDoc: fakePdf('fp' + n, n) as never, yieldEveryPage: true });
    run = false;
    const ms = performance.now() - t0;
    console.log(`[SPD] ${n} pages ${ms.toFixed(0)}ms = ${(ms / n).toFixed(1)} ms/page, maxBlock ${maxB.toFixed(0)}ms`);
    if (n === 600) expect(ms).toBeLessThan(perfBudget(6000));
  }
}, 600_000);
