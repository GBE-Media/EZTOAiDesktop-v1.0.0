import { useCanvasStore } from '@/store/canvasStore';
import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import type { ApprovalRequest } from '@/types/assistant';
import { isPageAnalysisRef } from '../agent/pageAnalysisRef';
import { commitMarkupsByConfidence } from './confidenceGate';
import { normalizeAgentMarkupPayload, type NormalizeDroppedRow } from './normalizeAgentMarkupPayload';
import { ensureCachedPageGeometry, placementMarkupsFromCachedItemIds } from './cachedCountMarkers';
import { verifyPlacementMarkupsWithGeometryGate } from './normalizeAgentMarkupPayload';
import type { PdfDocumentLike } from './loadPageGeometries';
import { bindTakeoffProducts, describeBoundProducts, type BoundProduct } from '../catalog/bindTakeoffProducts';

export type MarkupExecutionResult = {
  status: 'ok' | 'partial' | 'failed';
  placed: number;
  autoCommitted: number;
  needsConfirmation: number;
  reviewQueued: number;
  dropped: Array<{ index?: number; itemId?: string; reason: string }>;
  error?: string;
  perMarker?: Array<{ index?: number; itemId?: string; reason: string }>;
  /** Products in the user's library the placed markers were linked to (created when missing). */
  products?: BoundProduct[];
  productsSummary?: string;
};

function isLegacyMarkupPair(item: unknown): item is { page: number; markup: CanvasMarkup } {
  if (!item || typeof item !== 'object') return false;
  return !!(item as { markup?: unknown }).markup && typeof (item as { markup: unknown }).markup === 'object';
}

function payloadRows(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  const rec = payload as Record<string, unknown>;
  if (Array.isArray(rec.markups)) return rec.markups;
  if (Array.isArray(rec.pointers)) return rec.pointers;
  if (Array.isArray(rec.callouts)) return rec.callouts;
  if (Array.isArray(rec.payload)) return rec.payload;
  return null;
}

export function newDirectPlaceMarkupsApprovalId(messageId: string): string {
  return `direct_${messageId}_${crypto.randomUUID()}`;
}

function agentMarkupIdPrefix(approval: ApprovalRequest): string {
  return `agent_${approval.id}`;
}

function readItemIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const rec = payload as Record<string, unknown>;
  if (!Array.isArray(rec.itemIds)) return [];
  return rec.itemIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

export type ResolvePlaceMarkupsOptions = {
  approval: ApprovalRequest;
  page: number;
  pageWidth: number;
  pageHeight: number;
  defaultStyle: MarkupStyle;
  pdfDocument?: PdfDocumentLike | null;
};

/**
 * Turn a place_markups / propose_callouts approval into concrete canvas markups
 * WITHOUT committing them. Used by both the live preview and the real placement
 * so the user previews exactly what will be placed.
 */
export async function resolvePlaceMarkups(
  options: ResolvePlaceMarkupsOptions,
): Promise<
  | { ok: true; markups: Array<{ page: number; markup: CanvasMarkup }>; dropped: MarkupExecutionResult['dropped'] }
  | { ok: false; failure: MarkupExecutionResult }
> {
  const payload = options.approval.payload;
  const itemIds = readItemIds(payload);
  const rows = payloadRows(payload);
  const includeReview = !!(payload && typeof payload === 'object'
    && (payload as { includeReviewMarkers?: unknown }).includeReviewMarkers);

  let markups: Array<{ page: number; markup: CanvasMarkup }> = [];
  const dropped: MarkupExecutionResult['dropped'] = [];

  if (itemIds.length > 0) {
    const rec = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (typeof rec.page !== 'number' || !Number.isInteger(rec.page) || rec.page <= 0) {
      const reason = 'place_markups with itemIds requires page';
      return { ok: false, failure: {
        status: 'failed',
        placed: 0,
        autoCommitted: 0,
        needsConfirmation: 0,
        reviewQueued: 0,
        dropped: itemIds.map(itemId => ({ itemId, reason })),
        error: reason,
        perMarker: itemIds.map(itemId => ({ itemId, reason })),
      } };
    }
    if (!isPageAnalysisRef(rec.analysisRef)) {
      const reason = 'place_markups with itemIds requires analysisRef';
      return { ok: false, failure: {
        status: 'failed',
        placed: 0,
        autoCommitted: 0,
        needsConfirmation: 0,
        reviewQueued: 0,
        dropped: itemIds.map(itemId => ({ itemId, reason })),
        error: reason,
        perMarker: itemIds.map(itemId => ({ itemId, reason })),
      } };
    }
    const page = rec.page;
    const refDocId = (rec.analysisRef as { docId?: string }).docId;
    if (refDocId) {
      const refPdf = useCanvasStore.getState().pdfDocuments[refDocId]?.pdfDocument;
      await ensureCachedPageGeometry(refDocId, page, (refPdf || options.pdfDocument) as PdfDocumentLike | null);
    }
    const fromCache = placementMarkupsFromCachedItemIds({
      itemIds,
      page,
      includeReviewMarkers: includeReview,
      idPrefix: agentMarkupIdPrefix(options.approval),
      defaultStyle: options.defaultStyle,
      analysisRef: rec.analysisRef,
    });
    for (const drop of fromCache.dropped) {
      dropped.push({ itemId: drop.itemId, reason: drop.reason });
    }
    if (fromCache.markups.length > 0) {
      const gatedGeometry = await verifyPlacementMarkupsWithGeometryGate({
        markups: fromCache.markups,
        pdfDocument: options.pdfDocument,
        defaultStyle: options.defaultStyle,
        idPrefix: agentMarkupIdPrefix(options.approval),
      });
      markups = [...gatedGeometry.verified, ...gatedGeometry.reviewOnly];
    }
  } else if (rows && rows.length > 0 && rows.every(isLegacyMarkupPair)) {
    markups = rows;
  } else if (rows && rows.length > 0 && rows.some(isLegacyMarkupPair) && !rows.every(isLegacyMarkupPair)) {
    const mixed = rows
      .map((row, index) => (!isLegacyMarkupPair(row) ? `row ${index + 1}: not a {page, markup} pair` : null))
      .filter((value): value is string => !!value);
    return { ok: false, failure: {
      status: 'failed',
      placed: 0,
      autoCommitted: 0,
      needsConfirmation: 0,
      reviewQueued: 0,
      dropped: mixed.map((reason, index) => ({ index, reason })),
      error: `Mixed payload is not a full {page, markup} set (${mixed[0]})`,
      perMarker: mixed.map((reason, index) => ({ index, reason })),
    } };
  } else {
    const normalized = await normalizeAgentMarkupPayload({
      payload,
      page: options.page,
      pageWidth: options.pageWidth,
      pageHeight: options.pageHeight,
      idPrefix: agentMarkupIdPrefix(options.approval),
      messageId: options.approval.messageId,
      defaultStyle: options.defaultStyle,
      pdfDocument: options.pdfDocument,
    });
    markups = normalized.markups;
    for (const drop of normalized.dropped) {
      dropped.push({ index: drop.index, reason: drop.reason });
    }
    if (markups.length === 0 && rows && rows.length > 0) {
      const first = dropped[0];
      const detail = first
        ? `row ${typeof first.index === 'number' ? first.index + 1 : '?'}: ${first.reason}`
        : 'no point/points';
      return { ok: false, failure: {
        status: 'failed',
        placed: 0,
        autoCommitted: 0,
        needsConfirmation: 0,
        reviewQueued: 0,
        dropped,
        error: `0 of ${rows.length} markers had usable coordinates (${detail})`,
        perMarker: dropped,
      } };
    }
  }

  return { ok: true, markups, dropped };
}

export async function executePlaceMarkupsApproval(options: ResolvePlaceMarkupsOptions & {
  placementMode?: 'auto' | 'confirm';
  addAIMarkupBatch: (
    markups: Array<{ page: number; markup: CanvasMarkup }>,
    pending?: boolean,
  ) => { ok: boolean; placed: number; reason?: string } | void;
  setPendingPlacements: (rows: Array<{ id: string; type: string; page: number; data: unknown }>) => void;
  getPendingPlacements: () => Array<{ id: string; type: string; page: number; data: unknown }>;
}): Promise<MarkupExecutionResult> {
  const resolved = await resolvePlaceMarkups(options);
  if ('failure' in resolved) return resolved.failure;
  const { markups, dropped } = resolved;

  if (markups.length === 0) {
    return {
      status: 'failed',
      placed: 0,
      autoCommitted: 0,
      needsConfirmation: 0,
      reviewQueued: 0,
      dropped,
      error: dropped[0]?.reason || 'No markers to place',
      perMarker: dropped,
    };
  }

  // Counted fixtures land on the user's products (created under "AI Takeoff" when missing).
  const products = bindTakeoffProducts(markups);

  const gated = commitMarkupsByConfidence({
    markups,
    forceConfirm: options.placementMode === 'confirm',
    addAIMarkupBatch: options.addAIMarkupBatch,
    setPendingPlacements: options.setPendingPlacements,
    getPendingPlacements: options.getPendingPlacements,
  });

  if (gated.failedReason) {
    return {
      status: 'failed',
      placed: 0,
      autoCommitted: 0,
      needsConfirmation: 0,
      reviewQueued: 0,
      dropped,
      error: gated.failedReason,
      perMarker: dropped,
    };
  }

  const status = dropped.length > 0 ? 'partial' : 'ok';
  return {
    status,
    placed: gated.placed,
    autoCommitted: gated.auto,
    needsConfirmation: gated.confirm,
    reviewQueued: gated.review,
    dropped,
    perMarker: dropped,
    ...(products.length ? { products, productsSummary: describeBoundProducts(products) } : {}),
    error: status === 'partial'
      ? `Placed ${gated.placed}; dropped ${dropped.length}`
      : undefined,
  };
}

export function formatDroppedSummary(dropped: NormalizeDroppedRow[], total: number): string {
  if (dropped.length === 0) return '';
  const first = dropped[0];
  return `${dropped.length} of ${total} markers dropped (row ${first.index + 1}: ${first.reason})`;
}
