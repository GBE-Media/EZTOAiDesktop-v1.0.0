import { describe, expect, it } from 'vitest';
import { generateOverlappingTileRegions, visionTileGridForPage } from './imageCapture';

// Effective DPI after OpenAI high-detail resizing: fit within 2048x2048, then scale the short side down to 768.
function effectiveDpi(wIn: number, hIn: number): number {
  let w = wIn * 216;
  let h = hIn * 216;
  const fit = Math.min(1, 2048 / Math.max(w, h));
  w *= fit; h *= fit;
  const short = Math.min(1, 768 / Math.min(w, h));
  w *= short;
  return w / wIn;
}

describe('visionTileGridForPage effective DPI', () => {
  const sheets: Array<[string, number, number, number]> = [
    ['letter', 8.5, 11, 4],
    ['11x17', 17, 11, 6],
    ['24x36', 36, 24, 16],
    ['30x42', 42, 30, 16],
  ];
  for (const [name, wIn, hIn, maxTiles] of sheets) {
    it(`${name}: every tile stays above 100 DPI under provider resize`, () => {
      const W = wIn * 72;
      const H = hIn * 72;
      const g = visionTileGridForPage(W, H);
      expect(g.rows * g.cols).toBeLessThanOrEqual(maxTiles);
      const regions = generateOverlappingTileRegions(W, H, g.rows, g.cols);
      const worst = Math.min(...regions.map(r => effectiveDpi(r.width / 72, r.height / 72)));
      expect(worst).toBeGreaterThanOrEqual(100);
    });
  }
});
