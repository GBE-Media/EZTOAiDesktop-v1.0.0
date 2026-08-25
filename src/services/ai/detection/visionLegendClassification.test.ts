import { describe, expect, it, vi } from 'vitest';
import type { DetectedItem } from '../providers/types';
import { parseLegendFromTextLines } from './legendAwareCounting';
import { E100_LEGEND_LINES } from './fixtures/lightingPlanE100.fixture';
import {
  NO_CONFIDENT_MATCH,
  applyVisionNativeLegendCounting,
  buildLegendClassificationPrompt,
  itemsHaveVisionLegendFields,
  resolveLegendAwareCounting,
  validateLegendTypeCode,
} from './visionLegendClassification';
import { applyLegendAwareCounting } from './legendAwareCounting';

function det(overrides: Partial<DetectedItem> & { id: string }): DetectedItem {
  return {
    type: 'unknown',
    name: 'unknown',
    trade: 'electrical',
    quantity: 1,
    location: { x: 10, y: 10 },
    confidence: 0.9,
    ...overrides,
  };
}

describe('vision-native legend classification', () => {
  const legend = parseLegendFromTextLines(E100_LEGEND_LINES);

  it('injects page legend codes and classification instructions into the vision prompt', () => {
    const prompt = buildLegendClassificationPrompt(legend);
    expect(prompt).toContain('B-NL');
    expect(prompt).toContain('A/EM/NL');
    expect(prompt).toContain(NO_CONFIDENT_MATCH);
    expect(prompt).toContain('legendTypeCode');
    expect(prompt).toContain('matchConfidence');
    expect(prompt).toContain('matchReasoning');
    expect(prompt).toMatch(/pick the specific variant only if you\s+can identify that distinguishing evidence/i);
  });

  it('threads valid legendTypeCode / matchConfidence / matchReasoning into legendTypeCounts', () => {
    const items = [
      det({
        id: '1',
        legendTypeCode: 'B-NL',
        matchConfidence: 'high',
        matchReasoning: 'Night-light glyph adjacent to fixture',
      }),
      det({
        id: '2',
        legendTypeCode: 'B',
        matchConfidence: 'high',
        matchReasoning: 'Base B cylinder; no NL marker',
      }),
      det({
        id: '3',
        legendTypeCode: 'B',
        matchConfidence: 'medium',
        matchReasoning: 'Matches B schedule symbol',
      }),
    ];
    expect(itemsHaveVisionLegendFields(items)).toBe(true);
    const result = applyVisionNativeLegendCounting({ items, legendEntries: legend });
    expect(result.legendTypeCounts['B-NL']).toBe(1);
    expect(result.legendTypeCounts.B).toBe(2);
    expect(result.reliability).toBe('high');
    expect(result.verification.notes[0]).toMatch(/Vision-native legend classification/i);
    expect(result.items[0].type).toBe('B-NL');
    expect(result.items[0].matchReasoning).toMatch(/Night-light/);
  });

  it('rejects invalid legendTypeCode not on the page legend', () => {
    const bad = validateLegendTypeCode('FAKE_TYPE_ZZZ', legend);
    expect(bad.ok).toBe(false);

    const result = applyVisionNativeLegendCounting({
      items: [det({
        id: 'bad',
        legendTypeCode: 'FAKE_TYPE_ZZZ',
        matchConfidence: 'high',
        matchReasoning: 'hallucinated',
      })],
      legendEntries: legend,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.legendTypeCounts.A ?? 0).toBe(0);
    expect(result.verification.notes.some((n) => /invalid legendTypeCode|unresolved/i.test(n))).toBe(true);
  });

  it('routes no_confident_match and low-confidence into unresolved/ambiguous (not counted)', () => {
    const result = applyVisionNativeLegendCounting({
      items: [
        det({
          id: 'nc',
          legendTypeCode: NO_CONFIDENT_MATCH,
          matchConfidence: 'low',
          matchReasoning: 'Symbol too blurry',
        }),
        det({
          id: 'low',
          legendTypeCode: 'B1',
          matchConfidence: 'low',
          matchReasoning: 'Possible washer but uncertain',
        }),
        det({
          id: 'ok',
          legendTypeCode: 'EX1',
          matchConfidence: 'high',
          matchReasoning: 'Exit sign glyph',
        }),
      ],
      legendEntries: legend,
    });
    expect(result.unresolved.some((i) => i.id === 'nc')).toBe(true);
    expect(result.ambiguous.some((a) => a.item.id === 'low')).toBe(true);
    expect(result.legendTypeCounts.B1).toBe(0);
    expect(result.legendTypeCounts.EX1).toBe(1);
    expect(result.reliability).not.toBe('high');
  });

  it('ADV: OCR-noise near symbol — mocked model keeps base code with reasoning', () => {
    // Mocked vision response: model sees noise "W4LL" but reasons it is not a legend marker.
    const result = applyVisionNativeLegendCounting({
      items: [det({
        id: 'ocr',
        type: 'B',
        name: 'cylinder near W4LL smear',
        legendTypeCode: 'B',
        matchConfidence: 'high',
        matchReasoning:
          'Adjacent OCR smear "W4LL" is not a schedule type code; no B1/B-NL visual marker — using base B',
      })],
      legendEntries: legend,
    });
    expect(result.items[0].type).toBe('B');
    expect(result.legendTypeCounts.B).toBe(1);
    expect(result.legendTypeCounts.B1).toBe(0);
    expect(result.items[0].matchReasoning).toMatch(/OCR smear|not a schedule/i);
  });

  it('ADV: generic legend wording echo does not use token-overlap primary path', () => {
    const items = [det({
      id: 'echo',
      type: 'wall mount light',
      name: 'wall mount light',
      legendTypeCode: 'B',
      matchConfidence: 'medium',
      matchReasoning: 'Base cylinder; wall/mount/light are generic schedule words, not B2 markers',
    })];
    const resolved = resolveLegendAwareCounting({
      items,
      legendEntries: [
        { typeCode: 'B', description: 'SURFACE CYLINDER', source: 'schedule' },
        { typeCode: 'B2', description: 'WALL MOUNT LIGHT', source: 'schedule' },
      ],
      applyTokenOverlapFallback: vi.fn(applyLegendAwareCounting),
    });
    expect(resolved.path).toBe('vision-native');
    expect(resolved.legendTypeCounts.B).toBe(1);
    expect(resolved.legendTypeCounts.B2 ?? 0).toBe(0);
    expect(resolved.path).not.toBe('token-overlap-fallback');
  });

  it('ADV: genuine variant (WASHER) representable via confident vision legendTypeCode', () => {
    const result = applyVisionNativeLegendCounting({
      items: [det({
        id: 'washer',
        legendTypeCode: 'B1',
        matchConfidence: 'high',
        matchReasoning: 'Wall-washer asymmetric optic matches TYPE B1 schedule symbol',
      })],
      legendEntries: legend,
    });
    expect(result.legendTypeCounts.B1).toBe(1);
    expect(result.items[0].matchConfidence).toBe('high');
  });

  it('falls back to token-overlap only when structured legend fields are absent', () => {
    const fallback = vi.fn(applyLegendAwareCounting);
    const items = [det({ id: 'legacy', type: 'B', name: 'night light fixture' })];
    const resolved = resolveLegendAwareCounting({
      items,
      legendEntries: legend,
      applyTokenOverlapFallback: fallback,
    });
    expect(resolved.path).toBe('token-overlap-fallback');
    expect(fallback).toHaveBeenCalledOnce();
  });
});
