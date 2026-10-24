import type { DetectedItem } from '../providers/types';
import type { PlacementMarkup } from '../providers/types';
import { getLatestFullPageAnalysis, itemIsUnresolvedForCounts, type PageAnalysisRef } from '../agent/pageAnalysisCache';
import { isPageAnalysisRef } from '../agent/pageAnalysisRef';
import { useCanvasStore } from '@/store/canvasStore';
import { CONFIDENCE_REVIEW, type PageGeometry } from './types';
import { pageGeometryFromUnrotated, visionLocationToDocPoint, type DisplayCrop } from './visionDisplayPctToDoc';
import type { DocPoint } from './types';
import type { MarkupStyle } from '@/types/markup';
import { cacheGet, cacheSet } from '@/lib/pageCache';
import { loadPageGeometries, type PdfDocumentLike } from './loadPageGeometries';

export type CachedItemLookupDrop = { itemId: string; reason: string };

const REVIEW_STYLE = (style: MarkupStyle): PlacementMarkup['style'] => ({
  strokeColor: '#f59e0b',
  fillColor: 'rgba(245, 158, 11, 0.16)',
  strokeWidth: style.strokeWidth,
  fontSize: style.fontSize,
  fontFamily: style.fontFamily,
});

const COUNT_STYLE = (style: MarkupStyle): PlacementMarkup['style'] => ({
  strokeColor: style.strokeColor,
  fillColor: style.fillColor,
  strokeWidth: style.strokeWidth,
  fontSize: style.fontSize,
  fontFamily: style.fontFamily,
});

export function isUnresolvedOrLowCountItem(
  item: DetectedItem,
  legendTypeCodes?: string[] | null,
): boolean {
  return itemIsUnresolvedForCounts(item, legendTypeCodes).unresolved;
}

export function detectionLocationToDocPoint(
  item: DetectedItem,
  page: PageGeometry | null | undefined,
  crop?: DisplayCrop,
): DocPoint | null {
  return visionLocationToDocPoint(item.location, page, crop);
}

export type CachedPageItemsLookup = {
  items: DetectedItem[];
  pageGeometry: PageGeometry | null;
  analysisRef?: PageAnalysisRef;
  legendTypeCodes?: string[];
  error?: string;
};

export function lookupCachedPageItems(options: {
  page: number;
  analysisRef?: unknown;
}): CachedPageItemsLookup {
  const canvas = useCanvasStore.getState();
  const refDocId = isPageAnalysisRef(options.analysisRef)
    ? options.analysisRef.docId
    : undefined;
  const docId = refDocId || canvas.activeDocId;
  if (!docId) {
    return { items: [], pageGeometry: null, error: 'No active document' };
  }
  const pdf = canvas.pdfDocuments[docId];
  if (!pdf) {
    return { items: [], pageGeometry: null, error: 'No active document' };
  }
  if (!isPageAnalysisRef(options.analysisRef)) {
    return {
      items: [],
      pageGeometry: null,
      error: 'place_markups with itemIds requires analysisRef',
    };
  }
  const analysisRef = options.analysisRef;
  if (analysisRef.page !== options.page) {
    return {
      items: [],
      pageGeometry: null,
      error: 'analysisRef.page does not match page',
    };
  }
  if (analysisRef.docId !== docId) {
    return {
      items: [],
      pageGeometry: null,
      error: 'Document does not match analysisRef; ask the AI to count again',
    };
  }
  const revision = pdf.contentRevision ?? 0;
  if (analysisRef.revision !== revision) {
    return {
      items: [],
      pageGeometry: null,
      error: 'Document revision changed after counting; ask the AI to count again',
    };
  }
  const cached = getLatestFullPageAnalysis(docId, options.page, revision);
  if (!cached?.analysis?.items) {
    return {
      items: [],
      pageGeometry: canvas.getPageGeometry(options.page),
      error: `No cached page analysis for page ${options.page}`,
    };
  }
  if (cached.analysisRef && cached.analysisRef.analysisId !== analysisRef.analysisId) {
    return {
      items: [],
      pageGeometry: canvas.getPageGeometry(options.page),
      analysisRef: cached.analysisRef,
      error: 'Page was re-analyzed after counting; ask the AI to count again',
    };
  }
  // Geometry of the counted document's page (not whichever tab is active).
  const stored = cacheGet<PageGeometry>('geometry', docId, options.page) || null;
  if (!stored) {
    return {
      items: [],
      pageGeometry: null,
      analysisRef: cached.analysisRef,
      error: 'Page geometry unavailable; ask the AI to count again',
    };
  }
  return {
    items: cached.analysis.items,
    pageGeometry: stored,
    analysisRef: cached.analysisRef,
    legendTypeCodes: cached.analysis.legendTypeCodes,
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
  pageGeometry?: PageGeometry | null;
  pageWidth?: number;
  pageHeight?: number;
  items?: DetectedItem[];
  analysisRef?: unknown;
  skipAnalysisRefCheck?: boolean;
  crop?: DisplayCrop;
  legendTypeCodes?: string[];
}): {
  markups: PlacementMarkup[];
  dropped: CachedItemLookupDrop[];
} {
  const dropped: CachedItemLookupDrop[] = [];
  const resolved = options.items
    ? {
      items: options.items,
      pageGeometry: options.pageGeometry
        || (options.pageWidth && options.pageHeight
          ? pageGeometryFromUnrotated({
            pageNumber: options.page,
            docWidth: options.pageWidth,
            docHeight: options.pageHeight,
          })
          : null),
      legendTypeCodes: options.legendTypeCodes,
    }
    : lookupCachedPageItems({ page: options.page, analysisRef: options.analysisRef });
  if (resolved.error && !options.items) {
    return {
      markups: [],
      dropped: options.itemIds.map(itemId => ({ itemId, reason: resolved.error as string })),
    };
  }
  const byId = new Map(resolved.items.map(item => [item.id, item]));
  const markups: PlacementMarkup[] = [];
  const seen = new Set<string>();

  options.itemIds.forEach((itemId, index) => {
    if (seen.has(itemId)) {
      dropped.push({ itemId, reason: 'duplicate itemId' });
      return;
    }
    seen.add(itemId);
    const item = byId.get(itemId);
    if (!item) {
      dropped.push({ itemId, reason: 'not in cached page analysis' });
      return;
    }
    const flag = itemIsUnresolvedForCounts(item, resolved.legendTypeCodes || options.legendTypeCodes);
    if (item.locationMissing || flag.reason === 'no location') {
      dropped.push({ itemId, reason: 'no location' });
      return;
    }
    if (flag.reason === 'invalid legend code' || flag.reason === 'missing legend code') {
      dropped.push({ itemId, reason: flag.reason });
      return;
    }
    const point = detectionLocationToDocPoint(item, resolved.pageGeometry, options.crop);
    if (!point) {
      dropped.push({ itemId, reason: 'no location' });
      return;
    }
    const review = flag.unresolved;
    if (review && !options.includeReviewMarkers) {
      dropped.push({ itemId, reason: 'unresolved or low-confidence (not placed as a count marker)' });
      return;
    }
    const code = (typeof item.legendTypeCode === 'string' && item.legendTypeCode.trim())
      ? item.legendTypeCode.trim()
      : item.type;
    markups.push({
      id: `${options.idPrefix}_item_${index + 1}`,
      type: 'count-marker',
      page: options.page,
      points: [point],
      style: review ? REVIEW_STYLE(options.defaultStyle) : COUNT_STYLE(options.defaultStyle),
      label: review ? '?' : code,
      linkedItemId: item.id,
      confidence: review ? CONFIDENCE_REVIEW : 0.85,
      pending: review,
      reviewMarker: review || undefined,
      aiNote: review
        ? 'Unconfirmed / low-confidence detection — excluded from confirmed counts'
        : undefined,
    });
  });

  return { markups, dropped };
}

/**
 * Make sure the page geometry (size + rotation) for a counted page is cached for that document.
 * Counting does not always load it, so placement / preview load it on demand.
 */
export async function ensureCachedPageGeometry(
  docId: string,
  page: number,
  pdfDocument?: PdfDocumentLike | null,
): Promise<boolean> {
  if (cacheGet<PageGeometry>('geometry', docId, page)) return true;
  const doc = pdfDocument || (useCanvasStore.getState().pdfDocuments[docId]?.pdfDocument as PdfDocumentLike | undefined);
  if (!doc || typeof (doc as { getPage?: unknown }).getPage !== 'function') return false;
  const { geometryByPage } = await loadPageGeometries({ pageNumbers: [page], pdfDocument: doc });
  const geometry = geometryByPage.get(page);
  if (!geometry) return false;
  cacheSet('geometry', docId, page, { ...geometry, pageNumber: page });
  return true;
}
