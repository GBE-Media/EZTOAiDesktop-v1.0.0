import { describe, expect, it } from 'vitest';
import type { DetectedItem } from '../providers/types';
import { crossCheckRadiusPt, describeCrossCheck, reconcileCrossCheck } from './crossCheck';

const W = 2592;
const H = 1728;

function item(id: string, x: number, y: number, code: string, extra: Partial<DetectedItem> = {}): DetectedItem {
  return {
    id,
    type: code,
    trade: 'electrical',
    name: `Type ${code}`,
    quantity: 1,
    location: { x, y },
    confidence: 0.8,
    legendTypeCode: code,
    matchConfidence: 'medium',
    ...extra,
  } as DetectedItem;
}

const opts = { model: 'google/gemini-4-argon', hasLegend: true };

describe('reconcileCrossCheck', () => {
  it('confirms detections both models place at the same spot and raises confidence', () => {
    const { items, stats } = reconcileCrossCheck(
      [item('p1', 20, 20, 'A'), item('p2', 60, 40, 'B')],
      [item('s1', 20.3, 20.2, 'A', { confidence: 0.9 }), item('s2', 60.1, 40, 'B')],
      W, H, opts,
    );
    expect(stats).toMatchObject({ agreed: 2, primaryOnly: 0, secondOnly: 0, typeConflicts: 0 });
    expect(items).toHaveLength(2);
    expect(items[0].crossCheck).toBe('agreed');
    expect(items[0].confidence).toBeCloseTo(0.95);
    // Position stays the primary model's (the symbol check snaps it afterwards).
    expect(items[0].location).toEqual({ x: 20, y: 20 });
  });

  it('adds second-model-only finds as review markers that do not count', () => {
    const { items, stats } = reconcileCrossCheck(
      [item('p1', 20, 20, 'A')],
      [item('s1', 20, 20, 'A'), item('s2', 70, 70, 'A')],
      W, H, opts,
    );
    expect(stats.secondOnly).toBe(1);
    const extra = items.find(i => i.crossCheck === 'second_only')!;
    expect(extra.matchConfidence).toBe('low');
    expect(extra.id).toBe('xcheck_s2');
    expect(extra.evidence).toMatch(/only by the second vision model/);
  });

  it('does not add second-only finds when the sheet has no legend (no review lane)', () => {
    const { items, stats } = reconcileCrossCheck(
      [item('p1', 20, 20, 'A')],
      [item('s2', 70, 70, 'A')],
      W, H, { ...opts, hasLegend: false },
    );
    expect(items).toHaveLength(1);
    expect(stats.secondOnly).toBe(1);
    expect(describeCrossCheck(stats, false)).toMatch(/not added/);
  });

  it('keeps primary-only detections counted unless their confidence is very low', () => {
    const { items, stats } = reconcileCrossCheck(
      [item('p1', 20, 20, 'A'), item('p2', 50, 50, 'A', { confidence: 0.3 })],
      [],
      W, H, opts,
    );
    expect(stats.primaryOnly).toBe(2);
    expect(items[0].matchConfidence).toBe('medium');
    expect(items[1].matchConfidence).toBe('low');
    expect(stats.sentToReview).toBe(1);
  });

  it('sends a type disagreement to review unless the main model was highly confident', () => {
    const medium = reconcileCrossCheck([item('p1', 20, 20, 'A')], [item('s1', 20, 20, 'B')], W, H, opts);
    expect(medium.stats.typeConflicts).toBe(1);
    expect(medium.items[0].matchConfidence).toBe('low');
    expect(medium.items[0].evidence).toMatch(/read this as B — review/);
    const high = reconcileCrossCheck([item('p1', 20, 20, 'A', { matchConfidence: 'high' })], [item('s1', 20, 20, 'B')], W, H, opts);
    expect(high.items[0].matchConfidence).toBe('high');
    expect(high.items).toHaveLength(1);
  });

  it('pairs same-type neighbours first in dense rows', () => {
    const r = crossCheckRadiusPt(W, H);
    const step = ((r * 0.6) / W) * 100;
    const { stats } = reconcileCrossCheck(
      [item('p1', 30, 30, 'A'), item('p2', 30 + step, 30, 'B')],
      [item('s1', 30 + step, 30, 'A'), item('s2', 30, 30, 'B')],
      W, H, opts,
    );
    expect(stats.agreed).toBe(2);
  });

  it('never pairs detections farther apart than a symbol', () => {
    const { stats } = reconcileCrossCheck([item('p1', 20, 20, 'A')], [item('s1', 23, 20, 'A')], W, H, opts);
    expect(stats).toMatchObject({ agreed: 0, primaryOnly: 1, secondOnly: 1 });
  });
});
