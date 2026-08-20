import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingPlacementsReviewList } from './PendingPlacementsReviewList';
import { describePendingPlacementReview } from './pendingPlacementReview';
import { GEOMETRY_FAILURE_NOTE } from '@/services/ai/placement/loadPageGeometries';
import type { CanvasMarkup } from '@/types/markup';

const style: CanvasMarkup['style'] = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
  opacity: 100,
};

function markup(partial: Partial<CanvasMarkup> & Pick<CanvasMarkup, 'id' | 'type' | 'page'>): CanvasMarkup {
  return {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    style,
    locked: false,
    author: 'AI',
    createdAt: new Date().toISOString(),
    aiGenerated: true,
    aiPending: true,
    ...partial,
  } as CanvasMarkup;
}

describe('describePendingPlacementReview', () => {
  it('prefers aiNote for geometry-verification failures', () => {
    const item = describePendingPlacementReview({
      id: 'g1',
      type: 'rectangle',
      page: 5,
      data: markup({
        id: 'g1',
        type: 'rectangle',
        page: 5,
        label: 'Panel',
        aiNote: GEOMETRY_FAILURE_NOTE,
        aiConfidence: 0.9,
      }),
    });
    expect(item.reason).toBe(GEOMETRY_FAILURE_NOTE);
    expect(item.page).toBe(5);
    expect(item.label).toBe('Panel');
  });

  it('derives a low-confidence reason when aiNote is absent', () => {
    const item = describePendingPlacementReview({
      id: 'c1',
      type: 'callout',
      page: 2,
      data: markup({
        id: 'c1',
        type: 'callout',
        page: 2,
        label: 'Outlet',
        content: '[1] Outlet',
        aiConfidence: 0.3,
      }),
    });
    expect(item.reason).toContain('Low confidence');
    expect(item.reason).toContain('0.30');
  });
});

describe('PendingPlacementsReviewList', () => {
  it('renders queued item aiNote text in the UI tree', () => {
    const html = renderToStaticMarkup(
      <PendingPlacementsReviewList
        pendingPlacements={[
          {
            id: 'review-geo',
            type: 'rectangle',
            page: 5,
            data: markup({
              id: 'review-geo',
              type: 'rectangle',
              page: 5,
              label: 'Breaker',
              aiNote: GEOMETRY_FAILURE_NOTE,
              aiConfidence: 0.44,
            }),
          },
          {
            id: 'review-conf',
            type: 'callout',
            page: 2,
            data: markup({
              id: 'review-conf',
              type: 'callout',
              page: 2,
              label: 'Dimmer',
              aiConfidence: 0.2,
            }),
          },
        ]}
      />,
    );

    expect(html).toContain(GEOMETRY_FAILURE_NOTE);
    expect(html).toContain('Page 5');
    expect(html).toContain('Breaker');
    expect(html).toContain('Low confidence (0.20)');
    expect(html).toContain('data-review-reason');
  });
});
