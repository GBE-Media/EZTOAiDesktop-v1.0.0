import { describe, expect, it } from 'vitest';
import { convertPlacementsToMarkups, isUsableVerifiedBox } from './convertPlacements';
import { createPageGeometry, docRectToRender, docToRender, verifyMarkupProposal } from './index';
import type { CanvasPlacement, PlacementMarkup } from '../providers/types';
import type { MarkupStyle } from '@/types/markup';
import type { MarkupProposal } from './types';
import { BASE_RENDER_SCALE } from './coords';

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

describe('convertPlacementsToMarkups rotation-aware output (Phase 5)', () => {
  it('applies PageGeometry.rotationDeg=90 through the real convert path (not raw scale)', () => {
    const page = createPageGeometry({
      pageNumber: 1,
      docWidth: 612,
      docHeight: 792,
      renderScale: BASE_RENDER_SCALE,
      rotationDeg: 90,
    });
    const docPoint = { x: 100, y: 200 };
    // Independent check against docToRender formula before asserting convert output.
    // 90° CW: (x,y) → (H - y, x) = (792 - 200, 100) = (592, 100)
    // × 1.5 → (888, 150)
    const expected = docToRender(docPoint, page);
    expect(expected).toEqual({ x: 888, y: 150 });

    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'rot-count',
        type: 'count-marker',
        page: 1,
        points: [docPoint],
      })],
    };
    const geometryByPage = new Map([[1, page]]);
    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      BASE_RENDER_SCALE,
      BASE_RENDER_SCALE,
      undefined,
      geometryByPage,
    );

    expect(result[0].markup).toMatchObject({
      type: 'count-marker',
      x: 888,
      y: 150,
    });
    // Must NOT equal non-rotated raw scale (100*1.5, 200*1.5).
    expect(result[0].markup).not.toMatchObject({ x: 150, y: 300 });
  });

  it('rotationDeg=0 through the real convert path matches pre-Phase-5 scale-only behavior', () => {
    const page = createPageGeometry({
      pageNumber: 1,
      docWidth: 612,
      docHeight: 792,
      renderScale: BASE_RENDER_SCALE,
      rotationDeg: 0,
    });
    const docPoint = { x: 100, y: 200 };
    expect(docToRender(docPoint, page)).toEqual({ x: 150, y: 300 });

    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'plain-count',
        type: 'count-marker',
        page: 1,
        points: [docPoint],
      })],
    };
    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      BASE_RENDER_SCALE,
      BASE_RENDER_SCALE,
      undefined,
      new Map([[1, page]]),
    );

    expect(result[0].markup).toMatchObject({
      type: 'count-marker',
      x: 150,
      y: 300,
    });
  });

  it('rotates callout box and leader points via docRectToRender / docToRender', () => {
    const page = createPageGeometry({
      pageNumber: 2,
      docWidth: 612,
      docHeight: 792,
      renderScale: BASE_RENDER_SCALE,
      rotationDeg: 90,
    });
    const verifiedBox = { x: 100, y: 200, width: 40, height: 20 };
    const leaderEnd = { x: 50, y: 250 };
    const expectedBox = docRectToRender(verifiedBox, page);
    const expectedLeader = docToRender(leaderEnd, page);

    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'rot-callout',
        type: 'callout',
        page: 2,
        calloutRef: 1,
        points: [{ x: 100, y: 200 }, { x: 140, y: 220 }],
        leaderPoints: [{ x: 100, y: 200 }, leaderEnd],
        content: '[1] Rotated',
      })],
    };

    const result = convertPlacementsToMarkups(
      placements,
      style,
      'group',
      BASE_RENDER_SCALE,
      BASE_RENDER_SCALE,
      [{ id: 'rot-callout', pending: false, confidence: 0.9, boundingBox: verifiedBox }],
      new Map([[2, page]]),
    );

    const markup = result[0].markup as {
      x: number;
      y: number;
      width: number;
      height: number;
      leaderPoints?: Array<{ x: number; y: number }>;
    };
    expect(markup.x).toBeCloseTo(expectedBox.x, 5);
    expect(markup.y).toBeCloseTo(expectedBox.y, 5);
    expect(markup.width).toBeCloseTo(Math.max(expectedBox.width, 72), 5);
    expect(markup.height).toBeCloseTo(Math.max(expectedBox.height, 28), 5);
    expect(markup.leaderPoints?.[1]).toEqual(expectedLeader);
  });
});
