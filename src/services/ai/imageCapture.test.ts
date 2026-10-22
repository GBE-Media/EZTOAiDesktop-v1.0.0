import { describe, expect, it } from 'vitest';
import { generateOverlappingTileRegions, visionTileGridForPage } from './imageCapture';

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

  it('computes a denser grid for a large sheet', () => {
    const small = visionTileGridForPage(612, 792);
    const large = visionTileGridForPage(36 * 72, 24 * 72);
    expect(large.cols).toBeGreaterThan(large.rows);
    expect(large.cols).toBeGreaterThan(small.cols);
    expect(large.rows * large.cols).toBeLessThanOrEqual(16);
  });

  it('caps letter and 11x17 while keeping ~138 DPI on 36x24', () => {
    const dpi = (w: number, h: number, grid: { rows: number; cols: number }) => (
      768 / (Math.min(w / grid.cols, h / grid.rows) / 72)
    );
    const letter = visionTileGridForPage(612, 792);
    const tabloid = visionTileGridForPage(17 * 72, 11 * 72);
    const eSize = visionTileGridForPage(36 * 72, 24 * 72);
    expect(letter.rows * letter.cols).toBeLessThanOrEqual(4);
    expect(tabloid.rows * tabloid.cols).toBeLessThanOrEqual(6);
    expect(dpi(36 * 72, 24 * 72, eSize)).toBeGreaterThan(125);
    expect(dpi(36 * 72, 24 * 72, eSize)).toBeLessThan(155);
  });
});
