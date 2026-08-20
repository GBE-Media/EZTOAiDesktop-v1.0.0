import { describe, expect, it } from 'vitest';
import { resolveMarkupDrawAppearance } from './markupDrawAppearance';
import type { CanvasMarkup } from '@/types/markup';

const base: CanvasMarkup = {
  id: 'm1',
  type: 'rectangle',
  page: 1,
  x: 0,
  y: 0,
  width: 40,
  height: 20,
  style: {
    strokeColor: '#000000',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 100,
    fontSize: 12,
    fontFamily: 'Arial',
  },
  locked: false,
  author: 'AI',
  createdAt: new Date().toISOString(),
  aiGenerated: true,
};

describe('resolveMarkupDrawAppearance', () => {
  it('applies emerald dashed pending treatment when aiPending is true', () => {
    const appearance = resolveMarkupDrawAppearance({
      markup: { ...base, aiPending: true },
      scale: 1,
    });
    expect(appearance.lineDash).toEqual([6, 4]);
    expect(appearance.strokeStyle).toBe('#10b981');
    expect(appearance.fillAlphaScale).toBe(0.7);
    expect(appearance.pendingBadge).toBe(true);
  });

  it('does not apply pending treatment when aiPending is false/undefined', () => {
    expect(resolveMarkupDrawAppearance({ markup: { ...base, aiPending: false } })).toEqual({
      lineDash: [],
      fillAlphaScale: 1,
      pendingBadge: false,
    });
    expect(resolveMarkupDrawAppearance({ markup: base }).pendingBadge).toBe(false);
  });
});
