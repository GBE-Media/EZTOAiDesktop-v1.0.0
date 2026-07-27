import { describe, expect, it } from 'vitest';
import {
  AI_CALLOUT_STYLE,
  chatPointersToGreenPlacements,
  ensureNumberedCalloutMentions,
} from './callouts';

describe('chatPointersToGreenPlacements', () => {
  it('creates a green labeled callout with a leader line', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'callout',
        ref: 1,
        xPct: 25,
        yPct: 30,
        boundsPct: { x: 20, y: 25, width: 10, height: 12 },
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
    expect(result.markups[0].leaderPoints?.[1]).toEqual({ x: 250, y: 155 });
  });

  it('creates a callout leader to a point when bounds are unavailable', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'callout',
        ref: 2,
        xPct: 50,
        yPct: 40,
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
        xPct: 98,
        yPct: 98,
        boundsPct: { x: 95, y: 96, width: 20, height: 10 },
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
});

describe('ensureNumberedCalloutMentions', () => {
  it('injects missing numbered mentions', () => {
    const text = ensureNumberedCalloutMentions('See the lighting control detail.', [
      { type: 'callout', ref: 1, xPct: 10, yPct: 10, label: 'Timeclock' },
    ]);
    expect(text).toContain('[1] Timeclock');
  });
});
