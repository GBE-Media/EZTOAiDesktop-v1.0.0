import type { CanvasMarkup } from '@/types/markup';
import { CONFIDENCE_AUTO, CONFIDENCE_REVIEW } from './types';

export type ConfidencePlacementBand = 'auto' | 'confirm' | 'review';

export type PageMarkupPair = { page: number; markup: CanvasMarkup };

export function confidencePlacementBand(
  confidence: number | null | undefined,
): ConfidencePlacementBand {
  const value = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  if (value >= CONFIDENCE_AUTO) return 'auto';
  if (value >= CONFIDENCE_REVIEW) return 'confirm';
  return 'review';
}

export function partitionMarkupsByConfidence(
  markups: PageMarkupPair[],
  options?: { forceConfirm?: boolean },
): {
  auto: PageMarkupPair[];
  confirm: PageMarkupPair[];
  review: PageMarkupPair[];
} {
  const auto: PageMarkupPair[] = [];
  const confirm: PageMarkupPair[] = [];
  const review: PageMarkupPair[] = [];

  for (const item of markups) {
    let band = confidencePlacementBand(item.markup.aiConfidence);
    // Global "Confirm" placement mode can only make auto stricter, never weaker.
    if (options?.forceConfirm && band === 'auto') band = 'confirm';

    if (band === 'auto') {
      auto.push({
        page: item.page,
        markup: { ...item.markup, aiPending: false },
      });
    } else if (band === 'confirm') {
      confirm.push({
        page: item.page,
        markup: { ...item.markup, aiPending: true },
      });
    } else {
      review.push({
        page: item.page,
        markup: { ...item.markup, aiPending: true },
      });
    }
  }

  return { auto, confirm, review };
}

export type PendingPlacementRow = {
  id: string;
  type: string;
  page: number;
  data: unknown;
};

/**
 * Commit markups according to confidence bands using existing canvas + pending queues.
 * - auto (>=0.75): place committed on canvas
 * - confirm (0.45–0.75): place on canvas as aiPending + pendingPlacements
 * - review (<0.45): pendingPlacements only (not painted until user confirms)
 */
export function commitMarkupsByConfidence(options: {
  markups: PageMarkupPair[];
  forceConfirm?: boolean;
  addAIMarkupBatch: (markups: PageMarkupPair[], pending?: boolean) => void;
  setPendingPlacements: (rows: PendingPlacementRow[]) => void;
  getPendingPlacements?: () => PendingPlacementRow[];
}): {
  auto: number;
  confirm: number;
  review: number;
  placed: number;
} {
  const { auto, confirm, review } = partitionMarkupsByConfidence(options.markups, {
    forceConfirm: options.forceConfirm,
  });

  if (auto.length > 0) {
    options.addAIMarkupBatch(auto, false);
  }
  if (confirm.length > 0) {
    options.addAIMarkupBatch(confirm, true);
  }

  const pendingRows: PendingPlacementRow[] = [
    ...confirm.map(({ page, markup }) => ({
      id: markup.id,
      type: markup.type,
      page: markup.page || page,
      data: markup,
    })),
    ...review.map(({ page, markup }) => ({
      id: markup.id,
      type: markup.type,
      page: markup.page || page,
      data: markup,
    })),
  ];

  if (pendingRows.length > 0) {
    const existing = options.getPendingPlacements?.() || [];
    const byId = new Map(existing.map(row => [row.id, row]));
    for (const row of pendingRows) byId.set(row.id, row);
    options.setPendingPlacements([...byId.values()]);
  }

  return {
    auto: auto.length,
    confirm: confirm.length,
    review: review.length,
    placed: auto.length + confirm.length,
  };
}
