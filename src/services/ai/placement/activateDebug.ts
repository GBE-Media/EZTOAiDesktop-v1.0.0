import { getTextContentWithBounds } from '@/lib/pdfLoader';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { anchorsFromLayout } from './anchors';
import { createPageGeometry } from './coords';
import { usePlacementDebugStore } from './debugStore';
import { loadPageGeometries } from './loadPageGeometries';
import { buildPageLayoutModel } from './pageModel';
import { DEFAULT_RENDER_SCALE } from './types';
import { useCanvasLayersStore } from '@/store/canvasLayersStore';

/**
 * Populate OCR/layout/anchor scene data for a page.
 * Resolves real per-page dimensions via loadPageGeometries (never document-wide page-1 size).
 * Does not force overlay visibility — layers/review mode control painting.
 */
export async function activatePlacementDebugForPage(options: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  /**
   * Optional override for tests only. Production callers should omit this so
   * dimensions always come from getPageDimensions via loadPageGeometries.
   */
  docWidth?: number;
  docHeight?: number;
  /**
   * When true, populate scene data even if analysis layers are hidden
   * (e.g. for future background prep). Never turns overlays on.
   */
  populateEvenIfHidden?: boolean;
  /** @deprecated No longer forces visibility; treated as populateEvenIfHidden. */
  forceEnable?: boolean;
  getPageDimensions?: (
    document: { getPage: (pageNumber: number) => Promise<unknown> },
    pageNumber: number,
  ) => Promise<{ width: number; height: number; rotationDeg?: 0 | 90 | 180 | 270 }>;
}): Promise<void> {
  const layers = useCanvasLayersStore.getState();
  const shouldPopulate =
    options.populateEvenIfHidden ||
    options.forceEnable ||
    layers.shouldPopulateAnalysisScene();

  if (!shouldPopulate) {
    return;
  }

  const debug = usePlacementDebugStore.getState();
  // Keep runtime enabled flag aligned with whether any layer may paint.
  debug.setEnabled(layers.anyAnalysisLayerVisible());

  const { geometryByPage, failedPages } = await loadPageGeometries({
    pageNumbers: [options.pageNumber],
    pdfDocument: options.pdfDoc,
    getPageDimensions: options.getPageDimensions,
    // Only used when PDF lookup is unavailable; never a cross-page fallback.
    singlePageFallback:
      options.docWidth && options.docHeight && options.docWidth > 0 && options.docHeight > 0
        ? {
          pageNumber: options.pageNumber,
          width: options.docWidth,
          height: options.docHeight,
        }
        : undefined,
  });

  const page = geometryByPage.get(options.pageNumber);
  if (!page || failedPages.has(options.pageNumber)) {
    // Fail closed: clear page-specific scene data rather than inventing geometry.
    debug.setDebugScene({
      page: createPageGeometry({
        pageNumber: options.pageNumber,
        docWidth: 1,
        docHeight: 1,
        renderScale: DEFAULT_RENDER_SCALE,
      }),
      ocrRects: [],
      anchors: [],
      proposals: [],
    });
    return;
  }

  try {
    const textItems = await getTextContentWithBounds(
      options.pdfDoc,
      options.pageNumber,
      DEFAULT_RENDER_SCALE,
    );
    const layout = buildPageLayoutModel({
      page,
      textItems,
      source: 'native',
      renderScaleUsed: DEFAULT_RENDER_SCALE,
    });
    const anchors = anchorsFromLayout(layout);

    debug.setDebugScene({
      page,
      ocrRects: layout.textBlocks.map(block => block.bounds),
      anchors,
    });
  } catch (error) {
    console.warn('Failed to build placement debug scene:', error);
    debug.setDebugScene({
      page,
      ocrRects: [],
      anchors: [],
      proposals: [],
    });
  }
}
