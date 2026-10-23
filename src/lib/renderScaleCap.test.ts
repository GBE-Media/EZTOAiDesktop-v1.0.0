import { describe, expect, it } from 'vitest';
import { capRenderScale, cssPageSize } from './renderScaleCap';

describe('render scale cap vs DocPoint mapping', () => {
  it('keeps CSS size at the uncapped scale while the backing store is reduced', () => {
    const pageW = 1728;
    const pageH = 2592;
    const requested = 8;
    const css = cssPageSize(requested, pageW, pageH);
    const backing = capRenderScale(requested * 4, pageW, pageH);
    expect(backing).toBeLessThan(requested * 4);
    expect(css.width).toBe(pageW * requested);
  });
});
