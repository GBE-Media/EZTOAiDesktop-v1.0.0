import { describe, expect, it, vi } from 'vitest';
import { createPageGeometry } from './coords';
import type { PlacementMarkup } from '../providers/types';
import { verifyPlacementMarkupsByPage } from './verifyPlacementsByPage';
import type { GeometryAnchor, PageGeometry } from './types';

const style: PlacementMarkup['style'] = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
};

function rectMarkup(id: string, page: number, box: { x: number; y: number; w: number; h: number }): PlacementMarkup {
  return {
    id,
    type: 'rectangle',
    page,
    points: [
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y + box.h },
    ],
    style,
    pending: false,
    confidence: 0.9,
  };
}

describe('verifyPlacementMarkupsByPage', () => {
  it('verifies each placement against its own page geometry and anchors', () => {
    const page2 = createPageGeometry({ pageNumber: 2, docWidth: 1000, docHeight: 800 });
    const page5 = createPageGeometry({ pageNumber: 5, docWidth: 612, docHeight: 2000 });

    const resolveSpy = vi.fn((pageNumber: number) => {
      if (pageNumber === 2) {
        return {
          page: page2,
          anchors: [{
            id: 'a2',
            type: 'endpoint' as const,
            point: { x: 110, y: 110 },
            confidence: 0.9,
            source: 'pdf_vector' as const,
          }] satisfies GeometryAnchor[],
        };
      }
      return {
        page: page5,
        // Nearby only to page-5's own markup center (310,310) — not to (110,110).
        anchors: [{
          id: 'a5',
          type: 'endpoint' as const,
          point: { x: 310, y: 310 },
          confidence: 0.9,
          source: 'pdf_vector' as const,
        }] satisfies GeometryAnchor[],
      };
    });

    const markups = [
      // Center (110,110) → snaps to a2
      rectMarkup('on-page-2', 2, { x: 100, y: 100, w: 20, h: 20 }),
      // Center (310,310) → snaps to a5
      rectMarkup('on-page-5', 5, { x: 300, y: 300, w: 20, h: 20 }),
    ];

    const verified = verifyPlacementMarkupsByPage({
      markups,
      resolvePageContext: resolveSpy,
      enableSnap: true,
    });

    expect(resolveSpy).toHaveBeenCalledWith(2);
    expect(resolveSpy).toHaveBeenCalledWith(5);
    expect(resolveSpy).toHaveBeenCalledTimes(2);

    expect(verified[0].proposal.pageNumber).toBe(2);
    expect(verified[0].proposal.boundingBox).toEqual({ x: 100, y: 100, width: 20, height: 20 });
    expect(verified[0].proposal.anchor?.refId).toBe('a2');

    expect(verified[1].proposal.pageNumber).toBe(5);
    expect(verified[1].proposal.boundingBox).toEqual({ x: 300, y: 300, width: 20, height: 20 });
    expect(verified[1].proposal.anchor?.refId).toBe('a5');
  });

  it('does not snap a page-5 placement to page-2 anchors (old shared-geometry bug)', () => {
    const page2 = createPageGeometry({ pageNumber: 2, docWidth: 1000, docHeight: 800 });
    const page5 = createPageGeometry({ pageNumber: 5, docWidth: 612, docHeight: 2000 });

    // Page-5 markup sits on top of page-2's snap point. With the old bug (always
    // using current/first page anchors), this would snap to a2. Correct behavior:
    // page 5 has no nearby anchors, so geometry is only clamped — not snapped to a2.
    const verified = verifyPlacementMarkupsByPage({
      markups: [rectMarkup('looks-like-page2', 5, { x: 100, y: 100, w: 20, h: 20 })],
      resolvePageContext: (pageNumber) => ({
        page: pageNumber === 5 ? page5 : page2,
        anchors: pageNumber === 2
          ? [{
            id: 'a2',
            type: 'endpoint',
            point: { x: 110, y: 110 },
            confidence: 0.9,
            source: 'pdf_vector',
          }]
          : [],
      }),
      enableSnap: true,
    });

    expect(verified[0].proposal.pageNumber).toBe(5);
    expect(verified[0].proposal.anchor?.refId).toBeUndefined();
    expect(verified[0].proposal.placementMode).not.toBe('snap_adjusted');
    expect(verified[0].proposal.boundingBox).toEqual({ x: 100, y: 100, width: 20, height: 20 });
  });

  it('clamps using each page\'s own dimensions, not a shared page size', () => {
    const page2 = createPageGeometry({ pageNumber: 2, docWidth: 1000, docHeight: 800 });
    const page5 = createPageGeometry({ pageNumber: 5, docWidth: 612, docHeight: 2000 });

    const overflow = verifyPlacementMarkupsByPage({
      markups: [rectMarkup('overflow-p5', 5, { x: 600, y: 10, w: 40, h: 20 })],
      resolvePageContext: (pageNumber) => ({
        page: pageNumber === 5 ? page5 : page2,
        anchors: [],
      }),
      enableSnap: false,
    });
    // Against page5 width 612: right edge clamps → width 12.
    // Against shared page2 width 1000 the old bug would keep width 40.
    expect(overflow[0].proposal.boundingBox).toEqual({ x: 600, y: 10, width: 12, height: 20 });
  });

  it('resolves a distinct page context per page number in the batch', () => {
    const calls: PageGeometry[] = [];
    verifyPlacementMarkupsByPage({
      markups: [
        rectMarkup('a', 1, { x: 10, y: 10, w: 10, h: 10 }),
        rectMarkup('b', 3, { x: 10, y: 10, w: 10, h: 10 }),
      ],
      resolvePageContext: (pageNumber) => {
        const page = createPageGeometry({
          pageNumber,
          docWidth: pageNumber === 1 ? 1000 : 500,
          docHeight: pageNumber === 1 ? 800 : 400,
        });
        calls.push(page);
        return { page, anchors: [] };
      },
    });
    expect(calls.map(page => page.pageNumber)).toEqual([1, 3]);
    expect(calls.map(page => page.docWidth)).toEqual([1000, 500]);
  });
});
