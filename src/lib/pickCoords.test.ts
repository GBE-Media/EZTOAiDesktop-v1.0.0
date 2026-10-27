import { describe, expect, it } from 'vitest';
import { canvasBoxToPagePct, canvasPointToPagePct, pagePctToCanvasPoint } from './pickCoords';

// A rotated 36×24 sheet at the 1.5× render scale: the overlay canvas in render px.
const W = 2592 * 1.5;
const H = 1728 * 1.5;

describe('question-card pick coordinates', () => {
  it('maps the whole sheet, corners included (keep-clear boxes anywhere on the page)', () => {
    expect(canvasPointToPagePct({ x: 0, y: 0 }, W, H)).toEqual({ xPct: 0, yPct: 0 });
    expect(canvasPointToPagePct({ x: W, y: H }, W, H)).toEqual({ xPct: 100, yPct: 100 });
    expect(canvasPointToPagePct({ x: W * 0.9, y: H * 0.1 }, W, H)).toEqual({ xPct: 90, yPct: 10 });
    const box = canvasBoxToPagePct({ x: W * 0.95, y: H * 0.95 }, { x: W * 0.8, y: H * 0.7 }, W, H);
    expect(box).toEqual({ xPct: 80, yPct: 70, wPct: 15, hPct: 25 });
  });

  it('round-trips a pick to the same spot on the canvas', () => {
    const p = pagePctToCanvasPoint(canvasPointToPagePct({ x: 3110.4, y: 777.6 }, W, H), W, H);
    expect(p.x).toBeCloseTo(3110.4, 0);
    expect(p.y).toBeCloseTo(777.6, 0);
    expect(canvasPointToPagePct({ x: -5, y: H * 2 }, W, H)).toEqual({ xPct: 0, yPct: 100 });
  });
});
