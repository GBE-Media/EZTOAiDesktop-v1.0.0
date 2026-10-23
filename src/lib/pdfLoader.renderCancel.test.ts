import { describe, expect, it } from 'vitest';
import { isRenderingCancelled } from './pdfLoader';

describe('render cancellation', () => {
  it('recognizes pdf.js RenderingCancelledException', () => {
    expect(isRenderingCancelled({ name: 'RenderingCancelledException' })).toBe(true);
    expect(isRenderingCancelled(new Error('nope'))).toBe(false);
  });
});
