import { beforeEach, describe, expect, it } from 'vitest';
import { cacheClearAll, cacheGet, PAGE_CACHE_LIMIT } from '@/lib/pageCache';
import { useCanvasStore } from './canvasStore';

describe('setTextWords pin option', () => {
  beforeEach(() => {
    cacheClearAll();
    useCanvasStore.getState().clearAllDocuments();
  });

  it('pins OCR words so extract-all native pages can evict without dropping OCR', () => {
    useCanvasStore.getState().setPdfDocument('doc-a', {}, 40, 612, 792);
    useCanvasStore.getState().setActiveDocId('doc-a');
    useCanvasStore.getState().setTextWords(1, [{ str: 'ocr', x: 0, y: 0, width: 1, height: 1, lineY: 0, index: 0 }], { pin: true });
    for (let page = 2; page <= PAGE_CACHE_LIMIT + 6; page++) {
      useCanvasStore.getState().setTextWords(page, [{ str: 'n', x: 0, y: 0, width: 1, height: 1, lineY: 0, index: 0 }], { pin: false });
    }
    expect(cacheGet('words', 'doc-a', 1)).toEqual([
      expect.objectContaining({ str: 'ocr' }),
    ]);
  });
});
