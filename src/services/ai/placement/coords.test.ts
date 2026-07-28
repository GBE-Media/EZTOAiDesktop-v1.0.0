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
    const clamped = clampDocRect({ x: -10, y: 790, width: 50, height: 40 }, page);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(790);
    expect(clamped.height).toBe(10);
    expect(isRectInPage({ x: 0, y: 0, width: 100, height: 100 }, page)).toBe(true);
    expect(isRectInPage({ x: 950, y: 0, width: 100, height: 10 }, page)).toBe(false);
  });
});
