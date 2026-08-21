import { describe, expect, it } from 'vitest';
import {
  clampDocRect,
  createPageGeometry,
  docToPct,
  docToRender,
  docRectToRender,
  getRenderPageSize,
  isRectInPage,
  pctToDoc,
  renderToDoc,
  renderRectToDoc,
  roundTripStable,
} from './coords';
import type { PageRotationDeg } from './types';

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

describe('placement coords with PageGeometry.rotationDeg', () => {
  const W = 1000;
  const H = 800;
  const scale = 2;

  function rotatedPage(rotationDeg: PageRotationDeg) {
    return createPageGeometry({
      pageNumber: 1,
      docWidth: W,
      docHeight: H,
      renderScale: scale,
      rotationDeg,
    });
  }

  it.each([90, 180, 270] as PageRotationDeg[])(
    'round-trips doc→render→doc within epsilon at %i°',
    (rotationDeg) => {
      const geom = rotatedPage(rotationDeg);
      const samples = [
        { x: 0, y: 0 },
        { x: W, y: 0 },
        { x: 0, y: H },
        { x: W, y: H },
        { x: 125.5, y: 340.25 },
        { x: W / 2, y: H / 2 },
      ];
      for (const doc of samples) {
        expect(roundTripStable(doc, geom, 1e-9)).toBe(true);
        const back = renderToDoc(docToRender(doc, geom), geom);
        expect(back.x).toBeCloseTo(doc.x, 10);
        expect(back.y).toBeCloseTo(doc.y, 10);
      }
    },
  );

  it.each([90, 180, 270] as PageRotationDeg[])(
    'round-trips render→doc→render within epsilon at %i°',
    (rotationDeg) => {
      const geom = rotatedPage(rotationDeg);
      const size = getRenderPageSize(geom);
      const samples = [
        { x: 0, y: 0 },
        { x: size.width, y: 0 },
        { x: 0, y: size.height },
        { x: size.width / 2, y: size.height / 2 },
        { x: 40, y: 90 },
      ];
      for (const render of samples) {
        const back = docToRender(renderToDoc(render, geom), geom);
        expect(back.x).toBeCloseTo(render.x, 10);
        expect(back.y).toBeCloseTo(render.y, 10);
      }
    },
  );

  it('maps known doc points to expected clockwise-rotated render positions', () => {
    // scale=1 for readable expected values
    const p90 = createPageGeometry({
      pageNumber: 1,
      docWidth: W,
      docHeight: H,
      renderScale: 1,
      rotationDeg: 90,
    });
    // CW 90: (x,y) → (H - y, x); size H×W
    expect(docToRender({ x: 0, y: 0 }, p90)).toEqual({ x: H, y: 0 });
    expect(docToRender({ x: 100, y: 200 }, p90)).toEqual({ x: H - 200, y: 100 });
    expect(getRenderPageSize(p90)).toEqual({ width: H, height: W });

    const p180 = createPageGeometry({
      pageNumber: 1,
      docWidth: W,
      docHeight: H,
      renderScale: 1,
      rotationDeg: 180,
    });
    expect(docToRender({ x: 0, y: 0 }, p180)).toEqual({ x: W, y: H });
    expect(docToRender({ x: 100, y: 200 }, p180)).toEqual({ x: W - 100, y: H - 200 });

    const p270 = createPageGeometry({
      pageNumber: 1,
      docWidth: W,
      docHeight: H,
      renderScale: 1,
      rotationDeg: 270,
    });
    // CW 270: (x,y) → (y, W - x)
    expect(docToRender({ x: 0, y: 0 }, p270)).toEqual({ x: 0, y: W });
    expect(docToRender({ x: 100, y: 200 }, p270)).toEqual({ x: 200, y: W - 100 });
    expect(getRenderPageSize(p270)).toEqual({ width: H, height: W });
  });

  it('treats missing/invalid rotation as identity (0°)', () => {
    const plain = createPageGeometry({
      pageNumber: 1,
      docWidth: W,
      docHeight: H,
      renderScale: scale,
    });
    expect(plain.rotationDeg).toBe(0);
    expect(docToRender({ x: 10, y: 20 }, plain)).toEqual({ x: 20, y: 40 });

    const bogus = createPageGeometry({
      pageNumber: 1,
      docWidth: W,
      docHeight: H,
      renderScale: 1,
      rotationDeg: 45 as unknown as PageRotationDeg,
    });
    expect(bogus.rotationDeg).toBe(0);
  });

  it('transforms rect AABBs through rotation (corners, not naive width scale)', () => {
    const p90 = createPageGeometry({
      pageNumber: 1,
      docWidth: W,
      docHeight: H,
      renderScale: 1,
      rotationDeg: 90,
    });
    const rendered = docRectToRender({ x: 0, y: 0, width: 10, height: 20 }, p90);
    const back = renderRectToDoc(rendered, p90);
    expect(back.x).toBeCloseTo(0, 10);
    expect(back.y).toBeCloseTo(0, 10);
    expect(back.width).toBeCloseTo(10, 10);
    expect(back.height).toBeCloseTo(20, 10);
  });
});
