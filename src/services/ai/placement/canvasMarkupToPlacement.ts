import type { CanvasMarkup } from '@/types/markup';
import type { PlacementMarkup } from '../providers/types';
import {
  BASE_RENDER_SCALE,
  createPageGeometry,
  renderRectToDoc,
  renderToDoc,
} from './coords';
import type { DocPoint, PageGeometry } from './types';

const DEFAULT_STYLE: PlacementMarkup['style'] = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
  fontSize: 12,
  fontFamily: 'Arial',
};

/**
 * Convert a canvas-space markup back to document-space PlacementMarkup
 * so it can run through per-page verification.
 *
 * When PageGeometry is supplied, uses renderToDoc (rotation-aware).
 * Otherwise falls back to uniform 1/scale (rotationDeg = 0).
 */
export function canvasMarkupToPlacementMarkup(
  page: number,
  markup: CanvasMarkup,
  scale: number = BASE_RENDER_SCALE,
  pageGeometry?: PageGeometry | null,
): PlacementMarkup | null {
  const geometry = pageGeometry || createPageGeometry({
    pageNumber: page,
    docWidth: 1,
    docHeight: 1,
    renderScale: scale > 0 ? scale : BASE_RENDER_SCALE,
    rotationDeg: 0,
  });

  const toDoc = (point: { x: number; y: number }): DocPoint =>
    renderToDoc(point, geometry);

  const style = {
    strokeColor: markup.style?.strokeColor || DEFAULT_STYLE.strokeColor,
    fillColor: markup.style?.fillColor || DEFAULT_STYLE.fillColor,
    strokeWidth: markup.style?.strokeWidth || DEFAULT_STYLE.strokeWidth,
    fontSize: markup.style?.fontSize,
    fontFamily: markup.style?.fontFamily,
  };
  const base = {
    id: markup.id,
    page: markup.page || page,
    style,
    label: markup.label,
    aiNote: markup.aiNote,
    confidence: markup.aiConfidence,
    calloutRef: markup.calloutRef,
    pending: markup.aiPending !== false,
  };

  if (markup.type === 'rectangle' || markup.type === 'ellipse' || markup.type === 'highlight') {
    const docRect = renderRectToDoc({
      x: markup.x,
      y: markup.y,
      width: markup.width,
      height: markup.height,
    }, geometry);
    return {
      ...base,
      type: 'rectangle',
      points: [
        { x: docRect.x, y: docRect.y },
        { x: docRect.x + docRect.width, y: docRect.y + docRect.height },
      ],
    };
  }

  if (markup.type === 'callout' || markup.type === 'text') {
    const docRect = renderRectToDoc({
      x: markup.x,
      y: markup.y,
      width: markup.width,
      height: markup.height,
    }, geometry);
    return {
      ...base,
      type: markup.type,
      points: [
        { x: docRect.x, y: docRect.y },
        { x: docRect.x + docRect.width, y: docRect.y + docRect.height },
      ],
      content: markup.content,
      leaderPoints: markup.leaderPoints?.map(point => toDoc(point)),
    };
  }

  if (markup.type === 'count-marker') {
    return {
      ...base,
      type: 'count-marker',
      points: [toDoc({ x: markup.x, y: markup.y })],
    };
  }

  if (markup.type === 'polyline' || markup.type === 'polygon' || markup.type === 'cloud' || markup.type === 'freehand') {
    const points = markup.points || [];
    if (points.length === 0) return null;
    return {
      ...base,
      type: markup.type === 'polygon' ? 'polygon' : 'polyline',
      points: points.map(point => toDoc(point)),
    };
  }

  if (markup.type === 'measurement-length' || markup.type === 'measurement-area') {
    const points = markup.points || [];
    if (points.length === 0) return null;
    return {
      ...base,
      type: markup.type,
      points: points.map(point => toDoc(point)),
    };
  }

  return null;
}
