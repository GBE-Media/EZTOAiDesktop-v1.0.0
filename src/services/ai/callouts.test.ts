import { describe, expect, it } from 'vitest';
import {
  AI_CALLOUT_STYLE,
  chatPointersToGreenPlacements,
  ensureNumberedCalloutMentions,
} from './callouts';

describe('chatPointersToGreenPlacements', () => {
  it('creates a green labeled callout with a leader line from DocPoint bounds', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'callout',
        ref: 1,
        point: { x: 250, y: 150 },
        bounds: { x: 200, y: 125, width: 100, height: 60 },
        label: 'Panel',
        note: 'Verified panel',
        confidence: 0.96,
      }],
      page: 3,
      pageWidth: 1000,
      pageHeight: 500,
      idPrefix: 'chat',
    });

    expect(result.markups).toHaveLength(1);
    expect(result.markups[0]).toMatchObject({
      type: 'callout',
      page: 3,
      style: AI_CALLOUT_STYLE,
      label: 'Panel',
      content: '[1] Panel',
      calloutRef: 1,
      confidence: 0.96,
      pending: true,
    });
    expect(result.markups[0].leaderPoints).toHaveLength(2);
    // Bounds center = (250, 155)
    expect(result.markups[0].leaderPoints?.[1]).toEqual({ x: 250, y: 155 });
  });

  it('creates a callout leader to a DocPoint when bounds are unavailable', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'callout',
        ref: 2,
        point: { x: 400, y: 240 },
        label: 'Outlet',
      }],
      page: 1,
      pageWidth: 800,
      pageHeight: 600,
      idPrefix: 'chat',
    });

    expect(result.markups[0]).toMatchObject({
      type: 'callout',
      content: '[2] Outlet',
      calloutRef: 2,
      points: expect.any(Array),
      pending: true,
    });
    expect(result.markups[0].leaderPoints?.[1]).toEqual({ x: 400, y: 240 });
  });

  it('clamps callout bubbles to the page', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'callout',
        ref: 1,
        point: { x: 98, y: 98 },
        bounds: { x: 95, y: 96, width: 20, height: 10 },
        label: 'Edge',
      }],
      page: 1,
      pageWidth: 100,
      pageHeight: 100,
      idPrefix: 'chat',
    });

    const bubble = result.markups[0].points[0];
    const bubbleEnd = result.markups[0].points[1];
    expect(bubble.x).toBeGreaterThanOrEqual(0);
    expect(bubble.y).toBeGreaterThanOrEqual(0);
    expect(bubbleEnd.x).toBeLessThanOrEqual(100);
    expect(bubbleEnd.y).toBeLessThanOrEqual(100);
  });

  it('preserves each pointer\'s own page and uses per-page sizes when provided', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [
        { type: 'callout', ref: 1, point: { x: 500, y: 400 }, page: 2, label: 'A' },
        { type: 'callout', ref: 2, point: { x: 100, y: 100 }, page: 5, label: 'B' },
      ],
      page: 1,
      pageWidth: 1000,
      pageHeight: 800,
      idPrefix: 'multi',
      pageSizes: {
        2: { width: 1000, height: 800 },
        5: { width: 200, height: 200 },
      },
    });

    expect(result.markups.map(m => m.page)).toEqual([2, 5]);
    // Page 5 is only 200 wide — bubble must clamp inside that page, not options.pageWidth.
    expect(result.markups[1].points[1].x).toBeLessThanOrEqual(200);
    expect(result.markups[1].points[1].y).toBeLessThanOrEqual(200);
  });
});

describe('ensureNumberedCalloutMentions', () => {
  it('injects missing numbered mentions', () => {
    const text = ensureNumberedCalloutMentions('See the lighting control detail.', [
      { type: 'callout', ref: 1, point: { x: 10, y: 10 }, label: 'Timeclock' },
    ]);
    expect(text).toContain('[1] Timeclock');
  });
});
