import { describe, expect, it } from 'vitest';
import { convertPlacementsToMarkups, isUsableVerifiedBox } from './convertPlacements';
import { createPageGeometry, verifyMarkupProposal } from './index';
import type { CanvasPlacement, PlacementMarkup } from '../providers/types';
import type { MarkupStyle } from '@/types/markup';
import type { MarkupProposal } from './types';

const style: MarkupStyle = {
  strokeColor: '#10b981',
  fillColor: 'transparent',
  strokeWidth: 2,
  opacity: 1,
  fontSize: 12,
  fontFamily: 'Arial',
};

const placementStyle: PlacementMarkup['style'] = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
};

function placement(overrides: Partial<PlacementMarkup> & Pick<PlacementMarkup, 'id' | 'type' | 'points'>): PlacementMarkup {
  return {
    page: 1,
    style: placementStyle,
    pending: false,
    ...overrides,
  };
}

describe('convertPlacementsToMarkups verified geometry (Phase 4 Step 1)', () => {
  it('places rectangle using verified boundingBox, not raw points', () => {
    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'rect-1',
        type: 'rectangle',
        // Raw points → box at (10,10)-(50,40)
        points: [{ x: 10, y: 10 }, { x: 50, y: 40 }],
      })],
    };
    const verifiedBox = { x: 100, y: 200, width: 80, height: 60 };
    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      1,
      1,
      [{ id: 'rect-1', pending: false, confidence: 0.9, boundingBox: verifiedBox }],
    );
    expect(result).toHaveLength(1);
    expect(result[0].markup).toMatchObject({
      type: 'rectangle',
      x: 100,
      y: 200,
      width: 80,
      height: 60,
    });
  });

  it('places callout from verified box and reattaches leader toward existing end', () => {
    const leaderEnd = { x: 20, y: 20 };
    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'callout-1',
        type: 'callout',
        calloutRef: 1,
        points: [{ x: 200, y: 200 }, { x: 320, y: 236 }],
        leaderPoints: [{ x: 200, y: 200 }, leaderEnd],
        content: '[1] Fixture',
      })],
    };
    const verifiedBox = { x: 40, y: 50, width: 100, height: 40 };
    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      1,
      1,
      [{ id: 'callout-1', pending: false, confidence: 0.9, boundingBox: verifiedBox }],
    );
    const markup = result[0].markup as {
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      leaderPoints?: Array<{ x: number; y: number }>;
    };
    expect(markup).toMatchObject({
      type: 'callout',
      x: 40,
      y: 50,
      width: 100,
      height: 40,
    });
    // Leader end preserved; start reattached to left/top edge (end is left/above box center).
    expect(markup.leaderPoints?.[1]).toEqual(leaderEnd);
    expect(markup.leaderPoints?.[0]).toEqual({ x: 40, y: 50 });
  });

  it('places count-marker at verified box center', () => {
    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'count-1',
        type: 'count-marker',
        points: [{ x: 10, y: 10 }],
      })],
    };
    const verifiedBox = { x: 80, y: 120, width: 40, height: 20 };
    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      1,
      1,
      [{ id: 'count-1', pending: false, confidence: 0.9, boundingBox: verifiedBox }],
    );
    expect(result[0].markup).toMatchObject({
      type: 'count-marker',
      x: 100, // 80 + 40/2
      y: 130, // 120 + 20/2
    });
  });

  it('translates polyline by center delta so shape is preserved on verified box', () => {
    const rawPoints = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
    ];
    // Raw AABB center = (10, 5). Verified center = (60, 55) → delta (50, 50).
    const verifiedBox = { x: 50, y: 50, width: 20, height: 10 };
    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'poly-1',
        type: 'polyline',
        points: rawPoints,
      })],
    };
    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      1,
      1,
      [{ id: 'poly-1', pending: false, confidence: 0.9, boundingBox: verifiedBox }],
    );
    const markup = result[0].markup as {
      type: string;
      points?: Array<{ x: number; y: number }>;
    };
    expect(markup.points).toEqual([
      { x: 50, y: 50 },
      { x: 70, y: 50 },
      { x: 70, y: 60 },
    ]);
  });

  it('falls back to raw points when boundingBox is non-finite or non-positive', () => {
    const placements: CanvasPlacement = {
      notes: [],
      markups: [
        placement({
          id: 'bad-nan',
          type: 'rectangle',
          points: [{ x: 10, y: 10 }, { x: 30, y: 25 }],
        }),
        placement({
          id: 'bad-zero',
          type: 'count-marker',
          points: [{ x: 5, y: 7 }],
        }),
      ],
    };

    expect(isUsableVerifiedBox({ x: 1, y: 1, width: Number.NaN, height: 10 })).toBe(false);
    expect(isUsableVerifiedBox({ x: 1, y: 1, width: 0, height: 10 })).toBe(false);

    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      1,
      1,
      [
        { id: 'bad-nan', pending: false, confidence: 0.5, boundingBox: { x: 99, y: 99, width: Number.NaN, height: 10 } },
        { id: 'bad-zero', pending: false, confidence: 0.5, boundingBox: { x: 99, y: 99, width: 0, height: 10 } },
      ],
    );

    expect(result).toHaveLength(2);
    expect(result[0].markup).toMatchObject({
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 20,
      height: 15,
    });
    expect(result[1].markup).toMatchObject({
      type: 'count-marker',
      x: 5,
      y: 7,
    });
  });

  it('uses verifyMarkupProposal corrected boundingBox when it differs from the raw proposal box', () => {
    const page = createPageGeometry({ pageNumber: 1, docWidth: 1000, docHeight: 800 });
    // Partially off-page: raw box will be clamped by verify.
    const rawProposal: MarkupProposal = {
      id: 'proposal_pl_0',
      pageNumber: 1,
      markupType: 'rectangle',
      boundingBox: { x: -20, y: 100, width: 50, height: 40 },
      confidence: 0.9,
      placementMode: 'exact',
      rationale: 'test',
      sourceSignals: ['unit'],
    };
    const verified = verifyMarkupProposal(rawProposal, { page, enableSnap: false });
    expect(verified.proposal.boundingBox).toEqual({ x: 0, y: 100, width: 30, height: 40 });
    expect(verified.proposal.boundingBox).not.toEqual(rawProposal.boundingBox);

    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'rect-off',
        type: 'rectangle',
        // Raw points match the uncorrected proposal box corners.
        points: [
          { x: rawProposal.boundingBox.x, y: rawProposal.boundingBox.y },
          {
            x: rawProposal.boundingBox.x + rawProposal.boundingBox.width,
            y: rawProposal.boundingBox.y + rawProposal.boundingBox.height,
          },
        ],
      })],
    };

    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      1,
      1,
      [{
        id: 'proposal_pl_0',
        pending: verified.requiresConfirmation,
        confidence: verified.proposal.confidence,
        boundingBox: verified.proposal.boundingBox,
      }],
    );

    expect(result[0].markup).toMatchObject({
      type: 'rectangle',
      x: 0,
      y: 100,
      width: 30,
      height: 40,
    });
  });
});
