import type {
  CanvasPlacement,
  ChatMarkupPointer,
  PlacementMarkup,
} from './providers/types';

export const AI_CALLOUT_STYLE: PlacementMarkup['style'] = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.14)',
  strokeWidth: 2,
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function chatPointersToGreenPlacements(options: {
  pointers: ChatMarkupPointer[];
  page: number;
  pageWidth: number;
  pageHeight: number;
  idPrefix: string;
}): CanvasPlacement {
  const { pointers, page, pageWidth, pageHeight, idPrefix } = options;

  return {
    markups: pointers.map((pointer, index): PlacementMarkup => {
      const bounds = pointer.boundsPct;
      if (
        pointer.type === 'rectangle' &&
        bounds &&
        bounds.width > 0 &&
        bounds.height > 0
      ) {
        const x = clamp((bounds.x / 100) * pageWidth, 0, pageWidth);
        const y = clamp((bounds.y / 100) * pageHeight, 0, pageHeight);
        const right = clamp(((bounds.x + bounds.width) / 100) * pageWidth, x, pageWidth);
        const bottom = clamp(((bounds.y + bounds.height) / 100) * pageHeight, y, pageHeight);

        return {
          id: `${idPrefix}_${index}`,
          type: 'rectangle',
          page,
          points: [{ x, y }, { x: right, y: bottom }],
          style: AI_CALLOUT_STYLE,
          label: pointer.label,
          aiNote: pointer.note,
          confidence: pointer.confidence,
          pending: true,
        };
      }

      return {
        id: `${idPrefix}_${index}`,
        type: pointer.type === 'text' ? 'text' : 'count-marker',
        page,
        points: [{
          x: clamp((pointer.xPct / 100) * pageWidth, 0, pageWidth),
          y: clamp((pointer.yPct / 100) * pageHeight, 0, pageHeight),
        }],
        style: AI_CALLOUT_STYLE,
        label: pointer.label,
        aiNote: pointer.note,
        confidence: pointer.confidence,
        pending: true,
      };
    }),
    notes: [],
  };
}
