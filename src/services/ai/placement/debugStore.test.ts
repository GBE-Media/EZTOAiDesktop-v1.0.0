import { describe, expect, it } from 'vitest';
import { createPageGeometry } from './coords';
import { applyDebugSceneUpdate, usePlacementDebugStore } from './debugStore';
import type { DocRect, MarkupProposal } from './types';

describe('applyDebugSceneUpdate (page-atomic debug scene)', () => {
  it('clears previous-page OCR rects when switching pages without new ocrRects', () => {
    const page2 = createPageGeometry({ pageNumber: 2, docWidth: 1000, docHeight: 800 });
    const page5 = createPageGeometry({ pageNumber: 5, docWidth: 612, docHeight: 2000 });
    const page2Ocr: DocRect[] = [{ x: 10, y: 20, width: 30, height: 40 }];

    const afterPage2 = applyDebugSceneUpdate(
      { page: page2, ocrRects: page2Ocr, anchors: [], proposals: [] },
      { page: null, ocrRects: [], anchors: [], proposals: [] },
    );
    expect(afterPage2.ocrRects).toEqual(page2Ocr);
    expect(afterPage2.page.docWidth).toBe(1000);

    // Switch to page 5 without supplying ocrRects — must NOT retain page-2 OCR.
    const afterPage5 = applyDebugSceneUpdate(
      { page: page5, anchors: [] },
      afterPage2,
    );
    expect(afterPage5.page.pageNumber).toBe(5);
    expect(afterPage5.page.docWidth).toBe(612);
    expect(afterPage5.page.docHeight).toBe(2000);
    expect(afterPage5.ocrRects).toEqual([]);
    expect(afterPage5.ocrRects).not.toEqual(expect.arrayContaining(page2Ocr));
  });

  it('uses the new page dimensions, not page-1 / previous page size', () => {
    const page1 = createPageGeometry({ pageNumber: 1, docWidth: 1000, docHeight: 800 });
    const page5 = createPageGeometry({ pageNumber: 5, docWidth: 612, docHeight: 2000 });
    const page5Ocr: DocRect[] = [{ x: 100, y: 200, width: 50, height: 60 }];

    const after = applyDebugSceneUpdate(
      { page: page5, ocrRects: page5Ocr, anchors: [], proposals: [] },
      {
        page: page1,
        ocrRects: [{ x: 1, y: 1, width: 2, height: 2 }],
        anchors: [],
        proposals: [],
      },
    );

    expect(after.page.docWidth).toBe(612);
    expect(after.page.docHeight).toBe(2000);
    expect(after.page.docWidth).not.toBe(page1.docWidth);
    expect(after.ocrRects).toEqual(page5Ocr);
    expect(after.ocrRects.some(rect => rect.x === 1 && rect.y === 1)).toBe(false);
  });

  it('preserves same-page proposals when refreshing OCR without proposals', () => {
    const page2 = createPageGeometry({ pageNumber: 2, docWidth: 1000, docHeight: 800 });
    const proposal: MarkupProposal = {
      id: 'p1',
      pageNumber: 2,
      markupType: 'callout',
      boundingBox: { x: 1, y: 2, width: 3, height: 4 },
      confidence: 0.9,
      placementMode: 'exact',
      rationale: 'test',
      sourceSignals: [],
    };

    const refreshed = applyDebugSceneUpdate(
      { page: page2, ocrRects: [{ x: 5, y: 5, width: 5, height: 5 }] },
      { page: page2, ocrRects: [], anchors: [], proposals: [proposal] },
    );
    expect(refreshed.proposals).toEqual([proposal]);
    expect(refreshed.ocrRects).toHaveLength(1);
  });

  it('clears store OCR when setDebugScene switches pages via the zustand API', () => {
    const store = usePlacementDebugStore.getState();
    store.clear();

    const page2 = createPageGeometry({ pageNumber: 2, docWidth: 1000, docHeight: 800 });
    const page5 = createPageGeometry({ pageNumber: 5, docWidth: 612, docHeight: 2000 });

    store.setDebugScene({
      page: page2,
      ocrRects: [{ x: 10, y: 10, width: 20, height: 20 }],
      anchors: [],
      proposals: [],
    });
    expect(usePlacementDebugStore.getState().ocrRects).toHaveLength(1);

    store.setDebugScene({
      page: page5,
      // omit ocrRects — previous page OCR must not linger
    });

    const next = usePlacementDebugStore.getState();
    expect(next.page?.pageNumber).toBe(5);
    expect(next.page?.docWidth).toBe(612);
    expect(next.ocrRects).toEqual([]);
    store.clear();
  });
});
