import { describe, expect, it } from 'vitest';
import {
  clampDocRect,
  createPageGeometry,
  docToPct,
  docToRender,
  isRectInPage,
  pctToDoc,
  renderToDoc,
  roundTripStable,
} from './coords';

const page = createPageGeometry({
  pageNumber: 1,
  docWidth: 1000,
  docHeight: 800,
  renderScale: 1.5,
});

describe('placement coords', () => {
  it('round-trips document ↔ render space', () => {
    const doc = { x: 120, y: 240 };
    const render = docToRender(doc, page);
    expect(render).toEqual({ x: 180, y: 360 });
    expect(renderToDoc(render, page)).toEqual(doc);
    expect(roundTripStable(doc, page)).toBe(true);
  });

  it('converts percent to document points and back', () => {
    const point = pctToDoc(50, 25, page);
    expect(point).toEqual({ x: 500, y: 200 });
    const pct = docToPct(point, page);
    expect(pct.xPct).toBeCloseTo(50);
    expect(pct.yPct).toBeCloseTo(25);
  });

  it('clamps and validates page bounds', () => {
    // Partial overlap at bottom-left: x=-10..40, y=790..830 against 1000x800 page
    const clamped = clampDocRect({ x: -10, y: 790, width: 50, height: 40 }, page);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(790);
    expect(clamped.width).toBe(40);
    expect(clamped.height).toBe(10);
    expect(isRectInPage({ x: 0, y: 0, width: 100, height: 100 }, page)).toBe(true);
    expect(isRectInPage({ x: 950, y: 0, width: 100, height: 10 }, page)).toBe(false);
  });

  it('intersects rects with the page instead of shifting off-page regions on-page', () => {
    // Entirely left of the page (right edge still < 0)
    const left = clampDocRect({ x: -50, y: 20, width: 20, height: 100 }, page);
    expect(left.width).toBeLessThanOrEqual(0);
    expect(left.height).toBe(100);

    // Entirely above the page (bottom edge still < 0)
    const above = clampDocRect({ x: 20, y: -40, width: 100, height: 20 }, page);
    expect(above.height).toBeLessThanOrEqual(0);
    expect(above.width).toBe(100);

    // Entirely right of the page
    const right = clampDocRect({ x: 1050, y: 20, width: 40, height: 50 }, page);
    expect(right.width).toBeLessThanOrEqual(0);

    // Entirely below the page
    const below = clampDocRect({ x: 20, y: 850, width: 40, height: 50 }, page);
    expect(below.height).toBeLessThanOrEqual(0);

    // Partial left-edge overlap: -10..20 becomes 0..20 (width 20, not original 30)
    const partialLeft = clampDocRect({ x: -10, y: 100, width: 30, height: 40 }, page);
    expect(partialLeft).toEqual({ x: 0, y: 100, width: 20, height: 40 });

    // Fully on-page unchanged
    expect(clampDocRect({ x: 10, y: 20, width: 100, height: 50 }, page)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });
});
