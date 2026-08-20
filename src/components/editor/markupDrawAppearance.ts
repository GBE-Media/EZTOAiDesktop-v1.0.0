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
