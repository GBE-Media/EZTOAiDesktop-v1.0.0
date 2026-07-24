import { describe, expect, it } from 'vitest';
import { generateOverlappingTileRegions } from './imageCapture';

describe('generateOverlappingTileRegions', () => {
  it('creates a 3x3 grid with non-overlapping ownership cells', () => {
    const regions = generateOverlappingTileRegions(900, 600);

    expect(regions).toHaveLength(9);
    expect(regions[0].ownership).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    expect(regions[8].ownership).toEqual({ x: 600, y: 400, width: 300, height: 200 });
  });

  it('expands interior crops while keeping them inside the page', () => {
    const regions = generateOverlappingTileRegions(900, 600, 3, 3, 0.12);
    const center = regions[4];

    expect(center.x).toBeLessThan(center.ownership.x);
    expect(center.y).toBeLessThan(center.ownership.y);
    expect(center.width).toBeGreaterThan(center.ownership.width);
    expect(center.height).toBeGreaterThan(center.ownership.height);
    expect(regions[0].x).toBe(0);
    expect(regions[0].y).toBe(0);
    expect(regions[8].x + regions[8].width).toBeCloseTo(900);
    expect(regions[8].y + regions[8].height).toBeCloseTo(600);
  });
});
