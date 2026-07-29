import { getTextContentWithBounds } from '@/lib/pdfLoader';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { anchorsFromLayout } from './anchors';
import { createPageGeometry } from './coords';
import { usePlacementDebugStore } from './debugStore';
import { buildPageLayoutModel } from './pageModel';
import { DEFAULT_RENDER_SCALE } from './types';
import { useCanvasLayersStore } from '@/store/canvasLayersStore';

/**
 * Populate OCR/layout/anchor scene data for a page.
 * Does not force overlay visibility — layers/review mode control painting.
 */
export async function activatePlacementDebugForPage(options: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  docWidth: number;
  docHeight: number;
  /**
   * When true, populate scene data even if analysis layers are hidden
   * (e.g. for future background prep). Never turns overlays on.
   */
  populateEvenIfHidden?: boolean;
  /** @deprecated No longer forces visibility; treated as populateEvenIfHidden. */
  forceEnable?: boolean;
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

  const page = createPageGeometry({
    pageNumber: options.pageNumber,
    docWidth: options.docWidth,
    docHeight: options.docHeight,
    renderScale: DEFAULT_RENDER_SCALE,
  });

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
    });
  }
}
