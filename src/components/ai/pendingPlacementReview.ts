import type { CanvasMarkup } from '@/types/markup';
import { CONFIDENCE_AUTO, CONFIDENCE_REVIEW } from '@/services/ai/placement/types';

export type PendingPlacementRow = {
  id: string;
  type: string;
  page: number;
  data: unknown;
};

export type PendingPlacementReviewItem = {
  id: string;
  page: number;
  type: string;
  label: string;
  /** Human-readable why this item is in the review/pending queue. */
  reason: string;
  confidence?: number;
};

function asMarkup(data: unknown): CanvasMarkup | null {
  if (!data || typeof data !== 'object') return null;
  return data as CanvasMarkup;
}

/**
 * Resolve a displayable review reason for a queued placement.
 * Prefers aiNote (geometry failure, model notes, etc.); otherwise derives
 * from confidence bands used by confidenceGate.
 */
export function describePendingPlacementReview(
  row: PendingPlacementRow,
): PendingPlacementReviewItem {
  const markup = asMarkup(row.data);
  const page = markup?.page || row.page || 1;
  const type = markup?.type || row.type || 'markup';
  const label = (
    markup?.label
    || (typeof (markup as { content?: string } | null)?.content === 'string'
      ? (markup as { content?: string }).content
      : undefined)
    || type
  ).trim();

  const note = typeof markup?.aiNote === 'string' ? markup.aiNote.trim() : '';
  const confidence = typeof markup?.aiConfidence === 'number' && Number.isFinite(markup.aiConfidence)
    ? markup.aiConfidence
    : undefined;

  let reason = note;
  if (!reason) {
    if (typeof confidence === 'number' && confidence < CONFIDENCE_REVIEW) {
      reason = `Low confidence (${confidence.toFixed(2)}) — needs review`;
    } else if (typeof confidence === 'number' && confidence < CONFIDENCE_AUTO) {
      reason = `Needs confirmation (confidence ${confidence.toFixed(2)})`;
    } else {
      reason = 'Pending review';
    }
  }

  return {
    id: row.id,
    page,
    type,
    label,
    reason,
    confidence,
  };
}

export function describePendingPlacementsReview(
  rows: PendingPlacementRow[],
): PendingPlacementReviewItem[] {
  return rows.map(describePendingPlacementReview);
}
