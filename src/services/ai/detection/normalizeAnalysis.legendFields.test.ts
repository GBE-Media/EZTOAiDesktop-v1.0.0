import '../agent/testGlobals';
import { describe, expect, it } from 'vitest';
import { normalizeAnalysis } from '../pipeline';
import { parseLegendFromTextLines } from './legendAwareCounting';
import { E100_LEGEND_LINES } from './fixtures/lightingPlanE100.fixture';
import { applyVisionNativeLegendCounting } from './visionLegendClassification';

describe('normalizeAnalysis legend field parsing boundary', () => {
  const legend = parseLegendFromTextLines(E100_LEGEND_LINES);

  it('parses realistic raw provider JSON including matchConfidence casing/whitespace variants', () => {
    const raw = {
      items: [
        {
          id: 'casing-low',
          type: 'fixture',
          name: 'uncertain B1',
          location: { x: 10, y: 20 },
          boundingBox: { x: 8, y: 18, width: 4, height: 4 },
          confidence: 0.7,
          legendTypeCode: 'B1',
          matchConfidence: 'Low',
          matchReasoning: 'Possible washer but uncertain',
        },
        {
          id: 'casing-high',
          type: 'exit',
          name: 'exit',
          location: { x: 30, y: 40 },
          confidence: 0.95,
          legendTypeCode: 'EX1',
          matchConfidence: '  HIGH  ',
          matchReasoning: 'Clear exit glyph',
        },
        {
          id: 'casing-medium',
          type: 'B',
          name: 'cylinder',
          location: { x: 50, y: 60 },
          confidence: 0.8,
          legendTypeCode: 'B',
          matchConfidence: 'Medium',
          matchReasoning: 'Base type',
        },
      ],
      dimensions: [],
      text: [],
      symbols: [],
    };

    const normalized = normalizeAnalysis(raw, 1, 'electrical');
    expect(normalized).not.toBeNull();
    const byId = Object.fromEntries(normalized!.items.map((i) => [i.id, i]));
    expect(byId['casing-low']?.matchConfidence).toBe('low');
    expect(byId['casing-high']?.matchConfidence).toBe('high');
    expect(byId['casing-medium']?.matchConfidence).toBe('medium');
    expect(byId['casing-low']?.legendTypeCode).toBe('B1');
    expect(byId['casing-high']?.legendTypeCode).toBe('EX1');

    // End-to-end through counting: "Low" must exclude B1 from totals (not default to medium).
    const counted = applyVisionNativeLegendCounting({
      items: normalized!.items,
      legendEntries: legend,
    });
    expect(counted.legendTypeCounts.B1).toBe(0);
    expect(counted.ambiguous.some((a) => a.item.id === 'casing-low')).toBe(true);
    expect(counted.legendTypeCounts.EX1).toBe(1);
    expect(counted.legendTypeCounts.B).toBe(1);
  });

  it('treats missing/null/empty/wrong-type legend fields as absent', () => {
    const raw = {
      items: [
        {
          id: 'missing',
          type: 'A',
          location: { x: 1, y: 2 },
          confidence: 0.9,
          // no legendTypeCode / matchConfidence / matchReasoning keys
        },
        {
          id: 'nullish',
          type: 'A',
          location: { x: 3, y: 4 },
          confidence: 0.9,
          legendTypeCode: null,
          matchConfidence: null,
          matchReasoning: null,
        },
        {
          id: 'empty',
          type: 'A',
          location: { x: 5, y: 6 },
          confidence: 0.9,
          legendTypeCode: '   ',
          matchConfidence: '',
          matchReasoning: 42,
        },
        {
          id: 'wrong-type',
          type: 'A',
          location: { x: 7, y: 8 },
          confidence: 0.9,
          legendTypeCode: 123,
          matchConfidence: true,
          matchReasoning: ['not', 'a', 'string'],
        },
      ],
      dimensions: [],
      text: [],
      symbols: [],
    };

    const normalized = normalizeAnalysis(raw, 2, 'electrical');
    expect(normalized).not.toBeNull();
    for (const item of normalized!.items) {
      expect(item.legendTypeCode).toBeUndefined();
      expect(item.matchConfidence).toBeUndefined();
      expect(item.matchReasoning).toBeUndefined();
    }
  });
});
