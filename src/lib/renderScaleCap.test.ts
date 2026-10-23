import { describe, expect, it } from 'vitest';
import { capRenderScale, cssPageSize, mapCssPointToPage } from './renderScaleCap';

describe('render scale cap vs DocPoint mapping', () => {
  it('keeps CSS mapping identical with and without the backing-store cap', () => {
    const pageW = 1728;
    const pageH = 2592;
    const requested = 1.5;
    const css = cssPageSize(requested, pageW, pageH);
    const backing = capRenderScale(requested * 4, pageW, pageH);
    expect(backing).toBeLessThan(requested * 4);

    const docPoint = { x: 412.5, y: 88 };
    const cssX = (docPoint.x / pageW) * css.width;
    const cssY = (docPoint.y / pageH) * css.height;
    const uncapped = mapCssPointToPage(cssX, cssY, css.width, css.height);
    const cappedCss = cssPageSize(requested, pageW, pageH);
    const withCap = mapCssPointToPage(cssX, cssY, cappedCss.width, cappedCss.height);
    expect(Math.abs(uncapped.x - withCap.x)).toBeLessThan(1e-9);
    expect(Math.abs(uncapped.y - withCap.y)).toBeLessThan(1e-9);
    expect(css.width).toBe(cappedCss.width);
  });
});
