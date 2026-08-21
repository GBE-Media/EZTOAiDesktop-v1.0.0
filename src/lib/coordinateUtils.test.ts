import { describe, expect, it } from 'vitest';
import {
  BASE_RENDER_SCALE,
  renderDimensionToScreen,
  renderPointsToScreen,
  renderToScreen,
  screenDimensionToRender,
  screenPointsToRender,
  screenToRender,
} from './coordinateUtils';

describe('coordinateUtils (screen ↔ render space)', () => {
  it('keeps BASE_RENDER_SCALE at 1.5 (render raster scale, not DocPoint)', () => {
    expect(BASE_RENDER_SCALE).toBe(1.5);
  });

  it('round-trips screen ↔ render at arbitrary zoom without changing values beyond float noise', () => {
    const zoom = 175;
    const screen = { x: 240, y: 90 };
    const render = screenToRender(screen.x, screen.y, zoom);
    const back = renderToScreen(render.x, render.y, zoom);
    expect(back.x).toBeCloseTo(screen.x, 10);
    expect(back.y).toBeCloseTo(screen.y, 10);
  });

  it('at 100% zoom, screen and render coordinates are identical', () => {
    expect(screenToRender(100, 50, 100)).toEqual({ x: 100, y: 50 });
    expect(renderToScreen(100, 50, 100)).toEqual({ x: 100, y: 50 });
    expect(screenDimensionToRender(40, 100)).toBe(40);
    expect(renderDimensionToScreen(40, 100)).toBe(40);
  });

  it('at 200% zoom, render is half of screen (same math as former screenToPdf/pdfToScreen)', () => {
    expect(screenToRender(200, 100, 200)).toEqual({ x: 100, y: 50 });
    expect(renderToScreen(100, 50, 200)).toEqual({ x: 200, y: 100 });
    expect(screenDimensionToRender(80, 200)).toBe(40);
    expect(renderDimensionToScreen(40, 200)).toBe(80);
  });

  it('maps point arrays consistently', () => {
    const points = [{ x: 10, y: 20 }, { x: 30, y: 40 }];
    const render = screenPointsToRender(points, 50);
    expect(render).toEqual([
      { x: 20, y: 40 },
      { x: 60, y: 80 },
    ]);
    expect(renderPointsToScreen(render, 50)).toEqual(points);
  });
});
