import type { PendingPlacementRow } from './pendingPlacementReview';
import { describePendingPlacementsReview } from './pendingPlacementReview';

/**
 * Compact per-item pending/review list for the AI toolbar.
 * Surfaces page, type/label, and the review reason (aiNote or derived).
 */
export function PendingPlacementsReviewList(props: {
  pendingPlacements: PendingPlacementRow[];
}) {
  const items = describePendingPlacementsReview(props.pendingPlacements);
  if (items.length === 0) return null;

  return (
    <ul
      className="max-h-28 overflow-y-auto space-y-1.5 px-3 pb-2"
      data-testid="pending-placements-review-list"
      aria-label="Pending markup review"
    >
      {items.map(item => (
        <li
          key={item.id}
          className="text-xs text-muted-foreground leading-snug border-l-2 border-amber-500/50 pl-2"
          data-pending-id={item.id}
        >
          <div className="text-foreground/90">
            Page {item.page} · {item.type}
            {item.label && item.label !== item.type ? ` · ${item.label}` : ''}
          </div>
          <div className="text-muted-foreground" data-review-reason="true">
            {item.reason}
          </div>
        </li>
      ))}
    </ul>
  );
}
