import type { CanvasMarkup } from '@/types/markup';
import type { PlacementMarkup } from '../providers/types';
import { BASE_RENDER_SCALE } from './coords';

const DEFAULT_STYLE: PlacementMarkup['style'] = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
  fontSize: 12,
  fontFamily: 'Arial',
};

function scalePoint(
  point: { x: number; y: number },
  inv: number,
): { x: number; y: number } {
  return { x: point.x * inv, y: point.y * inv };
}

/**
 * Convert a canvas-space markup back to document-space PlacementMarkup
 * so it can run through per-page verification.
 */
export function canvasMarkupToPlacementMarkup(
  page: number,
  markup: CanvasMarkup,
  scale: number = BASE_RENDER_SCALE,
): PlacementMarkup | null {
  const inv = scale > 0 ? 1 / scale : 1;
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
    return {
      ...base,
      type: 'rectangle',
      points: [
        { x: markup.x * inv, y: markup.y * inv },
        { x: (markup.x + markup.width) * inv, y: (markup.y + markup.height) * inv },
      ],
    };
  }

  if (markup.type === 'callout' || markup.type === 'text') {
    return {
      ...base,
      type: markup.type,
      points: [
        { x: markup.x * inv, y: markup.y * inv },
        { x: (markup.x + markup.width) * inv, y: (markup.y + markup.height) * inv },
      ],
      content: markup.content,
      leaderPoints: markup.leaderPoints?.map(point => scalePoint(point, inv)),
    };
  }

  if (markup.type === 'count-marker') {
    return {
      ...base,
      type: 'count-marker',
      points: [{ x: markup.x * inv, y: markup.y * inv }],
    };
  }

  if (markup.type === 'polyline' || markup.type === 'polygon' || markup.type === 'cloud' || markup.type === 'freehand') {
    const points = markup.points || [];
    if (points.length === 0) return null;
    return {
      ...base,
      type: markup.type === 'polygon' ? 'polygon' : 'polyline',
      points: points.map(point => scalePoint(point, inv)),
    };
  }

  if (markup.type === 'measurement-length' || markup.type === 'measurement-area') {
    const points = markup.points || [];
    if (points.length === 0) return null;
    return {
      ...base,
      type: markup.type,
      points: points.map(point => scalePoint(point, inv)),
    };
  }

  return null;
}
