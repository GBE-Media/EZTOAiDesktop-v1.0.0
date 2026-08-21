import { describe, expect, it, vi } from 'vitest';
import { loadPageGeometries, GEOMETRY_FAILURE_NOTE } from './loadPageGeometries';
import { createPageGeometry } from './coords';

describe('loadPageGeometries', () => {
  it('loads distinct per-page dimensions from the PDF', async () => {
    const getPageDimensions = vi.fn(async (_doc: unknown, pageNumber: number) => {
      if (pageNumber === 2) return { width: 1000, height: 800 };
      if (pageNumber === 5) return { width: 612, height: 2000 };
      throw new Error(`unexpected page ${pageNumber}`);
    });

    const result = await loadPageGeometries({
      pageNumbers: [2, 5],
      pdfDocument: { getPage: async () => ({}) },
      getPageDimensions,
      singlePageFallback: { pageNumber: 1, width: 10, height: 10 },
    });

    expect(result.failedPages.size).toBe(0);
    expect(result.geometryByPage.get(2)).toEqual(
      createPageGeometry({ pageNumber: 2, docWidth: 1000, docHeight: 800 }),
    );
    expect(result.geometryByPage.get(5)).toEqual(
      createPageGeometry({ pageNumber: 5, docWidth: 612, docHeight: 2000 }),
    );
    // Must never silently use page-1 / document-wide fallback when PDF lookup works.
    expect(result.geometryByPage.get(2)?.docWidth).not.toBe(10);
  });

  it('fail-closes pages whose dimension lookup throws (no page-1 fallback)', async () => {
    const getPageDimensions = vi.fn(async (_doc: unknown, pageNumber: number) => {
      if (pageNumber === 1) return { width: 1000, height: 800 };
      throw new Error('page missing');
    });

    const result = await loadPageGeometries({
      pageNumbers: [1, 5],
      pdfDocument: { getPage: async () => ({}) },
      getPageDimensions,
      singlePageFallback: { pageNumber: 1, width: 1000, height: 800 },
    });

    expect(result.geometryByPage.has(1)).toBe(true);
    expect(result.geometryByPage.has(5)).toBe(false);
    expect(result.failedPages.has(5)).toBe(true);
    expect(result.failedPages.has(1)).toBe(false);
  });

  it('allows caller single-page fallback only when there is no PDF and one matching page', async () => {
    const ok = await loadPageGeometries({
      pageNumbers: [3],
      pdfDocument: null,
      singlePageFallback: { pageNumber: 3, width: 700, height: 500 },
    });
    expect(ok.failedPages.size).toBe(0);
    expect(ok.geometryByPage.get(3)?.docWidth).toBe(700);

    const multi = await loadPageGeometries({
      pageNumbers: [2, 5],
      pdfDocument: null,
      singlePageFallback: { pageNumber: 1, width: 1000, height: 800 },
    });
    expect(multi.geometryByPage.size).toBe(0);
    expect([...multi.failedPages].sort()).toEqual([2, 5]);
  });

  it('exports a stable geometry-failure note', () => {
    expect(GEOMETRY_FAILURE_NOTE).toBe('could not verify page geometry');
  });

  it('threads real pdfjs page.rotate through getPageDimensions into PageGeometry.rotationDeg', async () => {
    const mediaW = 612;
    const mediaH = 792;
    const pdfDocument = {
      getPage: async () => ({
        rotate: 90,
        getViewport: ({ scale = 1, rotation }: { scale?: number; rotation?: number }) => {
          const rot = rotation !== undefined ? rotation : 90;
          const normalized = ((rot % 360) + 360) % 360;
          if (normalized === 90 || normalized === 270) {
            return { width: mediaH * scale, height: mediaW * scale };
          }
          return { width: mediaW * scale, height: mediaH * scale };
        },
      }),
    };

    // Intentionally omit getPageDimensions override — must use production pdfLoader path.
    const result = await loadPageGeometries({
      pageNumbers: [1],
      pdfDocument: pdfDocument as never,
    });

    expect(result.failedPages.size).toBe(0);
    const page = result.geometryByPage.get(1);
    expect(page?.rotationDeg).toBe(90);
    expect(page?.docWidth).toBe(mediaW);
    expect(page?.docHeight).toBe(mediaH);
  });
});
