import { useCanvasStore } from '@/store/canvasStore';
import { anchorsFromLayout, anchorsFromVectorSnap } from './anchors';
import { buildPageLayoutModel } from './pageModel';
import type { GeometryAnchor, PageGeometry } from './types';
import { DEFAULT_RENDER_SCALE } from './types';

/**
 * Collect live page anchors for markup verification/snapping.
 * Uses canvas text cache (layout/text/corner anchors) plus any extracted
 * PDF vector snap data (endpoints / intersections / midpoints).
 * Returns [] when neither source has data — callers should treat snap as a no-op.
 */
export function resolvePageAnchors(options: {
  page: PageGeometry;
  pageNumber: number;
}): GeometryAnchor[] {
  const canvas = useCanvasStore.getState();
  const textItems = canvas.getTextContent(options.pageNumber) || [];
  const layoutAnchors = textItems.length > 0
    ? anchorsFromLayout(buildPageLayoutModel({
      page: options.page,
      textItems,
      source: 'native',
      // Canvas text cache is stored at the base render scale.
      renderScaleUsed: DEFAULT_RENDER_SCALE,
    }))
    : [];

  const snap = canvas.getDocumentSnapData(options.pageNumber);
  const vectorAnchors = snap
    ? anchorsFromVectorSnap(snap, options.pageNumber)
    : [];

  return [...layoutAnchors, ...vectorAnchors];
}
