import { describe, expect, it } from 'vitest';
import { AI_CALLOUT_STYLE, chatPointersToGreenPlacements } from './callouts';

describe('chatPointersToGreenPlacements', () => {
  it('creates a green labeled rectangle from verified bounds', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'rectangle',
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
      type: 'rectangle',
      page: 3,
      points: [{ x: 200, y: 125 }, { x: 300, y: 185 }],
      style: AI_CALLOUT_STYLE,
      label: 'Panel',
      confidence: 0.96,
      pending: true,
    });
  });

  it('uses a green point marker when bounds are unavailable', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'count-marker',
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
      type: 'count-marker',
      points: [{ x: 400, y: 240 }],
      style: AI_CALLOUT_STYLE,
      pending: true,
    });
  });

  it('clamps boxes to the page', () => {
    const result = chatPointersToGreenPlacements({
      pointers: [{
        type: 'rectangle',
        xPct: 98,
        yPct: 98,
        boundsPct: { x: 95, y: 96, width: 20, height: 10 },
      }],
      page: 1,
      pageWidth: 100,
      pageHeight: 100,
      idPrefix: 'chat',
    });

    expect(result.markups[0].points[1]).toEqual({ x: 100, y: 100 });
  });
});
