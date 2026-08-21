import { describe, expect, it, vi } from 'vitest';
import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import { BASE_RENDER_SCALE } from './coords';
import { CONFIDENCE_REVIEW } from './types';
import { GEOMETRY_FAILURE_NOTE, geometryFailureConfidence } from './loadPageGeometries';
import {
  normalizeAgentMarkupPayload,
  verifyPlacementMarkupsWithGeometryGate,
} from './normalizeAgentMarkupPayload';
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
