import { describe, expect, it, vi } from 'vitest';
import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import { BASE_RENDER_SCALE } from './coords';
import { CONFIDENCE_REVIEW } from './types';
import { GEOMETRY_FAILURE_NOTE, geometryFailureConfidence, loadPageGeometries } from './loadPageGeometries';
import {
  normalizeAgentMarkupPayload,
  verifyPlacementMarkupsWithGeometryGate,
} from './normalizeAgentMarkupPayload';
import { canvasMarkupToPlacementMarkup } from './canvasMarkupToPlacement';
import type { PlacementMarkup } from '../providers/types';
import { commitMarkupsByConfidence } from './confidenceGate';

const defaultStyle: MarkupStyle = {
  strokeColor: '#10b981',
  fillColor: 'rgba(16, 185, 129, 0.18)',
  strokeWidth: 2,
  opacity: 100,
};

function rectCanvasMarkup(page: number, id: string, box: { x: number; y: number; w: number; h: number }): CanvasMarkup {
  return {
    id,
    type: 'rectangle',
    page,
    x: box.x * BASE_RENDER_SCALE,
    y: box.y * BASE_RENDER_SCALE,
    width: box.w * BASE_RENDER_SCALE,
    height: box.h * BASE_RENDER_SCALE,
    style: defaultStyle,
    locked: false,
    author: 'AI',
    createdAt: new Date().toISOString(),
    aiGenerated: true,
    aiConfidence: 0.9,
  };
}

describe('normalizeAgentMarkupPayload multi-page', () => {
  it('verifies legacy [{page, markup}] rows against each row\'s own page geometry', async () => {
    const getPageDimensions = vi.fn(async (_doc: unknown, pageNumber: number) => {
      if (pageNumber === 2) return { width: 1000, height: 800 };
      if (pageNumber === 5) return { width: 612, height: 2000 };
      throw new Error(`unexpected ${pageNumber}`);
    });

    // Overflow on page 5: against width 612 clamps to width 12.
    // Against page-2 width 1000 the old flatten bug would keep width 40.
    const payload = [
      { page: 2, markup: rectCanvasMarkup(2, 'leg-p2', { x: 100, y: 100, w: 20, h: 20 }) },
      { page: 5, markup: rectCanvasMarkup(5, 'leg-p5', { x: 600, y: 10, w: 40, h: 20 }) },
    ];

    const result = await normalizeAgentMarkupPayload({
      payload,
      page: 1,
      pageWidth: 1000,
      pageHeight: 800,
      idPrefix: 'legacy',
      messageId: 'msg_1',
      defaultStyle,
      pdfDocument: { getPage: async () => ({}) },
      getPageDimensions,
      resolveAnchors: () => [],
    });

    expect(getPageDimensions).toHaveBeenCalledWith(expect.anything(), 2);
    expect(getPageDimensions).toHaveBeenCalledWith(expect.anything(), 5);

    const byId = Object.fromEntries(result.map(row => [row.markup.id, row]));
    expect(byId['leg-p2'].page).toBe(2);
    expect(byId['leg-p2'].markup.page).toBe(2);
    expect(byId['leg-p5'].page).toBe(5);
    expect(byId['leg-p5'].markup.page).toBe(5);

    // Clamped against page-5 width 612 → doc width 12 → canvas 12 * scale
    expect(byId['leg-p5'].markup).toMatchObject({
      type: 'rectangle',
      x: 600 * BASE_RENDER_SCALE,
      y: 10 * BASE_RENDER_SCALE,
      width: 12 * BASE_RENDER_SCALE,
      height: 20 * BASE_RENDER_SCALE,
    });
  });

  it('preserves per-pointer page values instead of flattening to options.page', async () => {
    const getPageDimensions = vi.fn(async (_doc: unknown, pageNumber: number) => {
      if (pageNumber === 2) return { width: 1000, height: 800 };
      if (pageNumber === 5) return { width: 612, height: 2000 };
      throw new Error(`unexpected ${pageNumber}`);
    });

    const result = await normalizeAgentMarkupPayload({
      payload: [
        { type: 'callout', ref: 1, point: { x: 500, y: 400 }, page: 2, label: 'On page 2', confidence: 0.9 },
        { type: 'callout', ref: 2, point: { x: 306, y: 1000 }, page: 5, label: 'On page 5', confidence: 0.9 },
      ],
      page: 1,
      pageWidth: 1000,
      pageHeight: 800,
      idPrefix: 'ptr',
      messageId: 'msg_2',
      defaultStyle,
      pdfDocument: { getPage: async () => ({}) },
      getPageDimensions,
      resolveAnchors: () => [],
    });

    expect(result).toHaveLength(2);
    expect(result.map(row => row.page).sort()).toEqual([2, 5]);
    expect(result.map(row => row.markup.page).sort()).toEqual([2, 5]);
    expect(result.every(row => row.markup.page !== 1)).toBe(true);
  });

  it('drops legacy-pct pointers when page size is unavailable (no fabricated (0,0) markup)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getPageDimensions = vi.fn(async () => {
      throw new Error('cannot load page geometry');
    });

    const result = await normalizeAgentMarkupPayload({
      payload: [
        { type: 'callout', ref: 1, xPct: 50, yPct: 50, page: 3, label: 'Legacy only' },
      ],
      page: 3,
      pageWidth: 1000,
      pageHeight: 800,
      idPrefix: 'reject',
      messageId: 'msg_reject',
      defaultStyle,
      pdfDocument: { getPage: async () => ({}) },
      getPageDimensions,
      resolveAnchors: () => [],
    });

    expect(result).toHaveLength(0);
    expect(result.some(row => {
      const m = row.markup as { x?: number; y?: number; width?: number; height?: number };
      return m.x === 0 || m.y === 0 || (m.x === 0 && m.y === 0);
    })).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some(call =>
      String(call.join(' ')).includes('missing page size'),
    )).toBe(true);
    warn.mockRestore();
  });
});

describe('verifyPlacementMarkupsWithGeometryGate (Path A fail-closed)', () => {
  it('routes getPageDimensions failures to review instead of placing with page-1 dims', async () => {
    const getPageDimensions = vi.fn(async (_doc: unknown, pageNumber: number) => {
      if (pageNumber === 1) return { width: 1000, height: 800 };
      throw new Error('cannot load page 5');
    });

    const style: PlacementMarkup['style'] = {
      strokeColor: '#10b981',
      fillColor: 'rgba(16, 185, 129, 0.18)',
      strokeWidth: 2,
    };
    const markups: PlacementMarkup[] = [
      {
        id: 'ok-p1',
        type: 'rectangle',
        page: 1,
        points: [{ x: 10, y: 10 }, { x: 30, y: 30 }],
        style,
        confidence: 0.9,
        pending: false,
      },
      {
        id: 'bad-p5',
        type: 'rectangle',
        page: 5,
        points: [{ x: 100, y: 100 }, { x: 140, y: 140 }],
        style,
        confidence: 0.9,
        pending: false,
      },
    ];

    const gated = await verifyPlacementMarkupsWithGeometryGate({
      markups,
      pdfDocument: { getPage: async () => ({}) },
      defaultStyle,
      idPrefix: 'pathA',
      getPageDimensions,
      resolveAnchors: () => [],
    });

    expect(gated.failedPages.has(5)).toBe(true);
    expect(gated.verified.map(row => row.markup.id)).toEqual(['ok-p1']);
    expect(gated.reviewOnly.map(row => row.markup.id)).toEqual(['bad-p5']);
    expect(gated.reviewOnly[0].markup.aiNote).toContain(GEOMETRY_FAILURE_NOTE);
    expect(gated.reviewOnly[0].markup.aiConfidence).toBe(geometryFailureConfidence(CONFIDENCE_REVIEW));

    const placed: string[] = [];
    const reviewQueue: string[] = [];
    commitMarkupsByConfidence({
      markups: [...gated.verified, ...gated.reviewOnly],
      addAIMarkupBatch: (rows) => {
        for (const row of rows) placed.push(row.markup.id);
      },
      setPendingPlacements: (rows) => {
        reviewQueue.push(...rows.map(row => row.id));
      },
    });

    expect(placed).toContain('ok-p1');
    expect(placed).not.toContain('bad-p5');
    expect(reviewQueue).toContain('bad-p5');
  });
});

describe('normalizeAgentMarkupPayload rotation integration (full production chain)', () => {
  const mediaW = 612;
  const mediaH = 792;

  /** Same mock shape as loadPageGeometries B3 test — real getPageDimensions / pdfLoader path. */
  function rotatedPdfDocument() {
    return {
      getPage: async () => ({
        rotate: 90,
        getViewport: ({ scale = 1, rotation }: { scale?: number; rotation?: number }) => {
          const rot = rotation !== undefined ? rotation : 90;
          const normalized = ((rot % 360) + 360) % 360;
          if (normalized === 90 || normalized === 270) {
            return { width: mediaH * scale, height: mediaW * scale };
          }
          return { width: mediaW * scale, height: mediaH * scale };
        },
      }),
    };
  }

  it('threads loaded rotation through normalize → loadPageGeometries → verify → convert (DocPoint target lands at 888,150)', async () => {
    // Agent pointer path becomes a callout; the DocPoint target is the leader end.
    // Same scenario as the unit-level convertPlacements test: 612×792, rot 90, (100,200), scale 1.5.
    const result = await normalizeAgentMarkupPayload({
      payload: [
        {
          type: 'callout',
          ref: 1,
          point: { x: 100, y: 200 },
          page: 1,
          label: 'Rotated target',
          confidence: 0.9,
        },
      ],
      page: 1,
      pageWidth: 10,
      pageHeight: 10,
      idPrefix: 'rot_chain',
      messageId: 'msg_rot_chain',
      defaultStyle,
      pdfDocument: rotatedPdfDocument() as never,
      // Intentionally omit getPageDimensions — must use production pdfLoader path.
      resolveAnchors: () => [],
    });

    expect(result).toHaveLength(1);
    const markup = result[0].markup as {
      type: string;
      x: number;
      y: number;
      leaderPoints?: Array<{ x: number; y: number }>;
    };
    expect(markup.type).toBe('callout');
    expect(markup.leaderPoints?.length).toBeGreaterThanOrEqual(2);

    const target = markup.leaderPoints![markup.leaderPoints!.length - 1];
    // Must match unit-level convertPlacements expectation exactly.
    expect(target).toEqual({ x: 888, y: 150 });
    // Wiring regression guard: raw scale without rotation would yield (150, 300).
    expect(target).not.toEqual({ x: 150, y: 300 });
    // Bubble itself is not the DocPoint — only the leader tip is.
    expect(markup.x).not.toBe(888);
  });

  it('round-trips render (888,150) back to DocPoint (100,200) via canvasMarkupToPlacement + loaded PageGeometry', async () => {
    const { geometryByPage, failedPages } = await loadPageGeometries({
      pageNumbers: [1],
      pdfDocument: rotatedPdfDocument() as never,
    });
    expect(failedPages.size).toBe(0);
    const page = geometryByPage.get(1);
    expect(page?.rotationDeg).toBe(90);
    expect(page?.docWidth).toBe(mediaW);
    expect(page?.docHeight).toBe(mediaH);

    const renderedMarkup: CanvasMarkup = {
      id: 'rt-count',
      type: 'count-marker',
      page: 1,
      x: 888,
      y: 150,
      number: 1,
      groupId: 'rt',
      style: defaultStyle,
      locked: false,
      author: 'AI',
      createdAt: new Date().toISOString(),
      aiGenerated: true,
      aiConfidence: 0.9,
    };

    const placement = canvasMarkupToPlacementMarkup(
      1,
      renderedMarkup,
      BASE_RENDER_SCALE,
      page,
    );
    expect(placement).not.toBeNull();
    expect(placement!.points).toHaveLength(1);
    expect(placement!.points[0].x).toBeCloseTo(100, 5);
    expect(placement!.points[0].y).toBeCloseTo(200, 5);
  });
});
