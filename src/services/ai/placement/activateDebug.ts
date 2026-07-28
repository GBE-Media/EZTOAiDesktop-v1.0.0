import { getTextContentWithBounds } from '@/lib/pdfLoader';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { anchorsFromLayout } from './anchors';
import { createPageGeometry, DEFAULT_RENDER_SCALE } from './coords';
import { usePlacementDebugStore } from './debugStore';
import { buildPageLayoutModel } from './pageModel';
import { useAISettingsStore } from '@/store/aiSettingsStore';

/**
 * Enable placement debug overlay and populate OCR/layout anchors for a page.
 * Overlay remains pointer-events: none so users can still edit markups.
 */
export async function activatePlacementDebugForPage(options: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  docWidth: number;
  docHeight: number;
  /** When true, force-enable overlay (e.g. on import). */
  forceEnable?: boolean;
}): Promise<void> {
  const debug = usePlacementDebugStore.getState();
  const settings = useAISettingsStore.getState();

  if (options.forceEnable) {
    settings.setShowPlacementDebug(true);
    debug.setEnabled(true);
  } else if (!settings.showPlacementDebug && !debug.enabled) {
    return;
  } else {
    debug.setEnabled(true);
  }

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
