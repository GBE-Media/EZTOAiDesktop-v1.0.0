import { describe, expect, it } from 'vitest';
import {
  commitMarkupsByConfidence,
  confidencePlacementBand,
  partitionMarkupsByConfidence,
} from './confidenceGate';
import { CONFIDENCE_AUTO, CONFIDENCE_REVIEW } from './types';
import type { CanvasMarkup } from '@/types/markup';

const style = {
  strokeColor: '#10b981',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  fontSize: 12,
  fontFamily: 'Arial',
};

function markup(id: string, confidence: number): CanvasMarkup {
  return {
    id,
    type: 'count-marker',
    page: 1,
    x: 10,
    y: 10,
    number: 1,
    groupId: 'test-group',
    style,
    locked: false,
    author: 'AI',
    createdAt: new Date().toISOString(),
    aiGenerated: true,
    aiConfidence: confidence,
  };
}

describe('confidence placement gating (Phase 4 Step 3)', () => {
  it('classifies bands using CONFIDENCE_AUTO / CONFIDENCE_REVIEW', () => {
    expect(confidencePlacementBand(CONFIDENCE_AUTO)).toBe('auto');
    expect(confidencePlacementBand(0.9)).toBe('auto');
    expect(confidencePlacementBand(CONFIDENCE_REVIEW)).toBe('confirm');
    expect(confidencePlacementBand(0.6)).toBe('confirm');
    expect(confidencePlacementBand(CONFIDENCE_REVIEW - 0.01)).toBe('review');
    expect(confidencePlacementBand(0.2)).toBe('review');
  });

  it('auto-commits >=0.75, marks mid-band as needing confirmation, and queues <0.45 for review only', () => {
    const batches: Array<{ pending: boolean; ids: string[] }> = [];
    let pendingQueue: Array<{ id: string; type: string; page: number; data: unknown }> = [];

    const result = commitMarkupsByConfidence({
      markups: [
        { page: 1, markup: markup('high', 0.9) },
        { page: 1, markup: markup('mid', 0.6) },
        { page: 1, markup: markup('low', 0.2) },
      ],
      addAIMarkupBatch: (items, pending) => {
        batches.push({
          pending: Boolean(pending),
          ids: items.map(item => item.markup.id),
        });
      },
      setPendingPlacements: rows => {
        pendingQueue = rows;
      },
      getPendingPlacements: () => pendingQueue,
    });

    expect(result).toEqual({
      auto: 1,
      confirm: 1,
      review: 1,
      placed: 2,
    });

    // High confidence: committed on canvas (pending=false)
    expect(batches).toContainEqual({ pending: false, ids: ['high'] });
    // Mid confidence: on canvas as aiPending
    expect(batches).toContainEqual({ pending: true, ids: ['mid'] });
    // Low confidence: NOT placed on canvas
    expect(batches.every(batch => !batch.ids.includes('low'))).toBe(true);

    // Mid + low appear in the existing pending/review queue UI
    expect(pendingQueue.map(row => row.id).sort()).toEqual(['low', 'mid']);
  });

  it('partition respects forceConfirm without promoting review into auto', () => {
    const { auto, confirm, review } = partitionMarkupsByConfidence(
      [
        { page: 1, markup: markup('high', 0.95) },
        { page: 1, markup: markup('low', 0.1) },
      ],
      { forceConfirm: true },
    );
    expect(auto).toHaveLength(0);
    expect(confirm.map(item => item.markup.id)).toEqual(['high']);
    expect(review.map(item => item.markup.id)).toEqual(['low']);
  });
});
