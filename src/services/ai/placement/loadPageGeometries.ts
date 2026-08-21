import { getPageDimensions as defaultGetPageDimensions } from '@/lib/pdfLoader';
import { createPageGeometry } from './coords';
import type { PageGeometry } from './types';

export type PdfDocumentLike = {
  getPage: (pageNumber: number) => Promise<unknown>;
};

export type PageGeometryLoadResult = {
  geometryByPage: Map<number, PageGeometry>;
  failedPages: Set<number>;
};

/**
 * Resolve real per-page document dimensions.
 *
 * Never invents geometry from a document-wide (page-1) fallback when a page
 * lookup fails. Optional singlePageFallback is only used when there is no PDF
 * document and every requested page is that one caller-supplied page.
 */
export async function loadPageGeometries(options: {
  pageNumbers: number[];
  pdfDocument?: PdfDocumentLike | null;
  singlePageFallback?: {
    pageNumber: number;
    width: number;
    height: number;
  };
  getPageDimensions?: (
    document: PdfDocumentLike,
    pageNumber: number,
  ) => Promise<{ width: number; height: number }>;
}): Promise<PageGeometryLoadResult> {
  const geometryByPage = new Map<number, PageGeometry>();
  const failedPages = new Set<number>();
  const uniquePages = Array.from(new Set(
    options.pageNumbers
      .map(page => Number(page) || 1)
      .filter(page => page > 0),
  ));
  const getDims = options.getPageDimensions
    || ((document: PdfDocumentLike, pageNumber: number) =>
      defaultGetPageDimensions(document as Parameters<typeof defaultGetPageDimensions>[0], pageNumber));

  await Promise.all(uniquePages.map(async (pageNumber) => {
    if (options.pdfDocument) {
      try {
        const dims = await getDims(options.pdfDocument, pageNumber);
        if (
          !Number.isFinite(dims.width)
          || !Number.isFinite(dims.height)
          || dims.width <= 0
          || dims.height <= 0
        ) {
          failedPages.add(pageNumber);
          return;
        }
        geometryByPage.set(pageNumber, createPageGeometry({
          pageNumber,
          docWidth: dims.width,
          docHeight: dims.height,
        }));
      } catch {
        failedPages.add(pageNumber);
      }
      return;
    }

    const fallback = options.singlePageFallback;
    const onlyFallbackPage = uniquePages.length === 1
      && fallback
      && pageNumber === fallback.pageNumber
      && Number.isFinite(fallback.width)
      && Number.isFinite(fallback.height)
      && fallback.width > 0
      && fallback.height > 0;

    if (onlyFallbackPage && fallback) {
      geometryByPage.set(pageNumber, createPageGeometry({
        pageNumber,
        docWidth: fallback.width,
        docHeight: fallback.height,
      }));
      return;
    }

    failedPages.add(pageNumber);
  }));

  return { geometryByPage, failedPages };
}

export const GEOMETRY_FAILURE_NOTE = 'could not verify page geometry';

/** Force review-band confidence so confidence gating never auto-places. */
export function geometryFailureConfidence(reviewThreshold = 0.45): number {
  return Math.max(0, reviewThreshold - 0.01);
}
