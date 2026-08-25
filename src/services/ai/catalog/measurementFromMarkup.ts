import type { CanvasMarkup } from '@/types/markup';
import type { LinkedMeasurement } from '@/types/product';

/**
 * Same measurement payload the manual count/measure tools use when linking
 * an active product (see MarkupCanvas). Shared by canvasStore undo/redo and
 * AI catalog attach (link_catalog / place_markups with productId).
 */
export function buildMeasurementFromMarkup(
  markup: CanvasMarkup,
  documentId: string,
): Omit<LinkedMeasurement, 'id' | 'createdAt'> | null {
  if (!documentId) return null;

  if (markup.type === 'count-marker') {
    const countMarkup = markup as CanvasMarkup & { groupId?: string };
    return {
      markupId: markup.id,
      documentId,
      page: markup.page,
      type: 'count',
      value: 1,
      unit: 'ea',
      groupId: countMarkup.groupId,
    };
  }

  if (markup.type === 'measurement-length' || markup.type === 'measurement-area') {
    const measurementMarkup = markup as CanvasMarkup & {
      scaledValue?: number;
      value?: number;
      unit?: string;
    };
    return {
      markupId: markup.id,
      documentId,
      page: markup.page,
      type: markup.type === 'measurement-length' ? 'length' : 'area',
      value: measurementMarkup.scaledValue ?? measurementMarkup.value ?? 0,
      unit: measurementMarkup.unit || 'ft',
    };
  }

  return null;
}
