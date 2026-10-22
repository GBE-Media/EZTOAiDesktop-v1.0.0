import type { DetectedItem } from '../providers/types';
import type { PlacementMarkup } from '../providers/types';
import { NO_CONFIDENT_MATCH, normalizeMatchConfidence } from '../detection/visionLegendClassification';
import { getLatestFullPageAnalysis } from '../agent/pageAnalysisCache';
import { useCanvasStore } from '@/store/canvasStore';
import { detectionPctToDocPointerFields } from './parseChatMarkupPointer';
import type { DocPoint } from './types';
import type { MarkupStyle } from '@/types/markup';

export type CachedItemLookupDrop = { itemId: string; reason: string };

const COUNT_STYLE = (style: MarkupStyle): PlacementMarkup['style'] => ({
  strokeColor: style.strokeColor,
  fillColor: style.fillColor,
  strokeWidth: style.strokeWidth,
  fontSize: style.fontSize,
  fontFamily: style.fontFamily,
});

export function isUnresolvedOrLowCountItem(item: DetectedItem): boolean {
  const code = typeof item.legendTypeCode === 'string' ? item.legendTypeCode : '';
  if (code && code.trim() === NO_CONFIDENT_MATCH) return true;
  if (normalizeMatchConfidence(item.matchConfidence) === 'low') return true;
  if (code && !code.trim()) return true;
  return false;
}

export function detectionLocationToDocPoint(
  item: DetectedItem,
  pageWidth: number,
  pageHeight: number,
): DocPoint | null {
  const loc = item.location;
  if (!loc || typeof loc.x !== 'number' || typeof loc.y !== 'number') return null;
  if (!Number.isFinite(loc.x) || !Number.isFinite(loc.y)) return null;
  return detectionPctToDocPointerFields(loc, item.boundingBox, pageWidth, pageHeight).point;
}

export function lookupCachedPageItems(page: number): {
  items: DetectedItem[];
  pageWidth: number;
  pageHeight: number;
  error?: string;
} {
  const canvas = useCanvasStore.getState();
  const docId = canvas.activeDocId;
  if (!docId) return { items: [], pageWidth: 0, pageHeight: 0, error: 'No active document' };
  const pdf = canvas.pdfDocuments[docId];
  if (!pdf) return { items: [], pageWidth: 0, pageHeight: 0, error: 'No active document' };
  const cached = getLatestFullPageAnalysis(docId, page, pdf.contentRevision ?? 0);
  if (!cached?.analysis?.items) {
    return {
      items: [],
      pageWidth: pdf.originalPageWidth || 0,
      pageHeight: pdf.originalPageHeight || 0,
      error: `No cached page analysis for page ${page}`,
    };
  }
  return {
    items: cached.analysis.items,
    pageWidth: pdf.originalPageWidth || 0,
    pageHeight: pdf.originalPageHeight || 0,
  };
}

/**
 * Build count-marker PlacementMarkups from cached analysis item ids.
 * Model coordinates are ignored. Unresolved / low-confidence items are review-only
 * when includeReviewMarkers is true; otherwise they are dropped.
 */
export function placementMarkupsFromCachedItemIds(options: {
  itemIds: string[];
  page: number;
  includeReviewMarkers?: boolean;
  idPrefix: string;
  defaultStyle: MarkupStyle;
  pageWidth?: number;
  pageHeight?: number;
  items?: DetectedItem[];
}): {
  markups: PlacementMarkup[];
  dropped: CachedItemLookupDrop[];
} {
  const dropped: CachedItemLookupDrop[] = [];
  const resolved = options.items
    ? { items: options.items, pageWidth: options.pageWidth || 0, pageHeight: options.pageHeight || 0 }
    : lookupCachedPageItems(options.page);
  if (resolved.error && !options.items) {
    return {
      markups: [],
      dropped: options.itemIds.map(itemId => ({ itemId, reason: resolved.error as string })),
    };
  }
  const byId = new Map(resolved.items.map(item => [item.id, item]));
  const markups: PlacementMarkup[] = [];

  options.itemIds.forEach((itemId, index) => {
    const item = byId.get(itemId);
    if (!item) {
      dropped.push({ itemId, reason: 'not in cached page analysis' });
      return;
    }
    const point = detectionLocationToDocPoint(item, resolved.pageWidth, resolved.pageHeight);
    if (!point) {
      dropped.push({ itemId, reason: 'no location' });
      return;
    }
    const review = isUnresolvedOrLowCountItem(item);
    if (review && !options.includeReviewMarkers) {
      dropped.push({ itemId, reason: 'unresolved or low-confidence (not placed as a count marker)' });
      return;
    }
    const code = (typeof item.legendTypeCode === 'string' && item.legendTypeCode.trim())
      ? item.legendTypeCode.trim()
      : item.type;
    markups.push({
      id: `${options.idPrefix}_item_${item.id || index + 1}`,
      type: 'count-marker',
      page: options.page,
      points: [point],
      style: COUNT_STYLE(options.defaultStyle),
      label: review ? `${code} (unconfirmed)` : code,
      linkedItemId: item.id,
      confidence: review ? 0.3 : 0.85,
      pending: review,
      aiNote: review ? 'Unconfirmed / low-confidence detection' : undefined,
    });
  });

  return { markups, dropped };
}
