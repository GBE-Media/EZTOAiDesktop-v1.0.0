import type { CanvasMarkup } from '@/types/markup';

export type MarkupDrawAppearance = {
  lineDash: number[];
  strokeStyle?: string;
  fillAlphaScale: number;
  pendingBadge: boolean;
};

/**
 * Visual treatment for AI markups awaiting confirmation (aiPending).
 * Emerald dashed stroke matches ApprovalCard's emerald pending accents.
 */
export function resolveMarkupDrawAppearance(options: {
  markup: CanvasMarkup;
  isEraserHovered?: boolean;
  scale?: number;
}): MarkupDrawAppearance {
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  if (options.markup.reviewMarker && !options.isEraserHovered) {
    return {
      lineDash: [6 / scale, 4 / scale],
      strokeStyle: '#f59e0b',
      fillAlphaScale: 0.7,
      pendingBadge: true,
    };
  }
  if (options.markup.aiPending && !options.isEraserHovered) {
    return {
      lineDash: [6 / scale, 4 / scale],
      strokeStyle: '#10b981',
      fillAlphaScale: 0.7,
      pendingBadge: true,
    };
  }
  return {
    lineDash: [],
    fillAlphaScale: 1,
    pendingBadge: false,
  };
}

/** Count-marker overlay drawn on the canvas (review markers only). */
export function countMarkerCaption(markup: Pick<CanvasMarkup, 'type' | 'reviewMarker'>): string | null {
  if (markup.type === 'count-marker' && markup.reviewMarker) return '?';
  return null;
}

const CONFIRMED_COUNT_STYLE = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
};

/** Turn a review/pending AI count marker into a normal committed marker. */
export function confirmedCountMarkerFields(markup?: CanvasMarkup): Partial<CanvasMarkup> {
  if (!markup) return { aiPending: false, reviewMarker: false };
  if (!markup.reviewMarker) return { aiPending: false, reviewMarker: false };
  return {
    aiPending: false,
    reviewMarker: false,
    label: markup.label === '?' ? undefined : markup.label,
    style: {
      ...markup.style,
      strokeColor: CONFIRMED_COUNT_STYLE.strokeColor,
      fillColor: CONFIRMED_COUNT_STYLE.fillColor,
    },
  };
}
