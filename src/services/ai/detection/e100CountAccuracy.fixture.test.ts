import '../agent/testGlobals';
import { describe, expect, it } from 'vitest';
import { countItemsFromAnalysis, parseMatchedLegendCodes } from '../agent/pageAnalysisCache';
import { generateOverlappingTileRegions, visionTileGridForPage } from '../imageCapture';
import { mapTileItemToPage, reconcileTileDetections, TILE_MERGE_RADIUS_PT } from '../pipeline';
import { groupTextIntoColumnLines } from '@/lib/pdfLoader';
import { applyLegendAwareCounting, parseLegendFromTextLines } from './legendAwareCounting';
import { resolveLegendAwareCounting } from './visionLegendClassification';
import type { BlueprintAnalysisResult, DetectedItem } from '../providers/types';
import { E100_LEGEND_LINES } from './fixtures/lightingPlanE100.fixture';

const E100_COUNTS = { A: 9, B: 5, EX1: 4, ER1: 2, S: 6 };

function item(
  id: string,
  code: string,
  x: number,
  y: number,
  extra?: Partial<DetectedItem>,
): DetectedItem {
  return {
    id,
    type: code,
    trade: 'electrical',
    name: `Type ${code}`,
    quantity: 1,
    location: { x, y },
    confidence: 0.9,
    legendTypeCode: code,
    matchConfidence: 'high',
    ...extra,
  };
}

function e100Analysis(items: DetectedItem[]): BlueprintAnalysisResult {
  return {
    page: 1,
    items,
    dimensions: [],
    text: [],
    symbols: [],
    legendTypeCodes: Object.keys(E100_COUNTS),
    legendTypeCounts: { ...E100_COUNTS },
    countReliability: 'high',
    typeCounts: { ...E100_COUNTS },
  };
}

describe('E-100 count query matching (fix 1)', () => {
  const items = [
    ...Array.from({ length: 9 }, (_, i) => item(`a${i}`, 'A', 10, 10 + i)),
    ...Array.from({ length: 5 }, (_, i) => item(`b${i}`, 'B', 20, 10 + i)),
    ...Array.from({ length: 4 }, (_, i) => item(`ex${i}`, 'EX1', 30, 10 + i)),
    ...Array.from({ length: 2 }, (_, i) => item(`er${i}`, 'ER1', 40, 10 + i)),
    ...Array.from({ length: 6 }, (_, i) => item(`s${i}`, 'S', 50, 10 + i)),
  ];
  const analysis = e100Analysis(items);

  it('Type A light fixtures only → 9, not A+S', () => {
    const result = countItemsFromAnalysis(analysis, 'Type A light fixtures only');
    expect(result.matchedCodes).toEqual(['A']);
    expect(result.total).toBe(9);
    expect(result.total).toBe(Object.values(result.matchingTypeCounts).reduce((a, b) => a + b, 0));
    expect(result.allTypeCounts).toEqual(E100_COUNTS);
    expect(result.countReliability).toBe('high');
  });

  it('Type B light fixtures only → 5, not B+S', () => {
    expect(countItemsFromAnalysis(analysis, 'Type B light fixtures only').total).toBe(5);
  });

  it('EX1 exit signs and ER1 emergency units only → 6', () => {
    const result = countItemsFromAnalysis(analysis, 'EX1 exit signs and ER1 emergency units only');
    expect(result.total).toBe(6);
    expect(result.matchingTypeCounts).toMatchObject({ EX1: 4, ER1: 2 });
  });

  it('Type S switches → 6', () => {
    expect(countItemsFromAnalysis(analysis, 'Type S switches').total).toBe(6);
  });

  it('query with no known code returns 0 and a note, not a fuzzy match', () => {
    const result = countItemsFromAnalysis(analysis, 'how many bananas');
    expect(result.total).toBe(0);
    expect(parseMatchedLegendCodes('how many bananas', Object.keys(E100_COUNTS))).toEqual([]);
    expect(result.message).toMatch(/not a fuzzy match/i);
  });

  it('does not treat filler "a" as Type A, and empty matchingItems when no code parsed', () => {
    const named = e100Analysis(items.map((row) => (
      row.legendTypeCode === 'EX1' ? { ...row, name: 'EXIT SIGN' } : row
    )));
    const exitSheet = countItemsFromAnalysis(named, 'how many exit signs are on a sheet');
    expect(exitSheet.matchingTypeCounts.A).toBeUndefined();
    expect(Object.keys(exitSheet.matchingTypeCounts).every(code => /EX|EXIT/i.test(code) || code === 'EX1')).toBe(true);
    expect(exitSheet.matchingItems).toEqual([]);

    const ab = countItemsFromAnalysis(analysis, 'A and B fixtures');
    expect(ab.total).toBe(14);
    expect(ab.matchingTypeCounts).toMatchObject({ A: 9, B: 5 });

    const exitSign = countItemsFromAnalysis(named, 'exit sign');
    expect(exitSign.matchingItems).toEqual([]);
  });
});

describe('unresolved list caps', () => {
  it('serializes 80 matching + 300 unresolved under 10k chars', () => {
    const matching = Array.from({ length: 80 }, (_, i) => item(`ok-${i}`, 'A', 10, 10 + i));
    const unresolved = Array.from({ length: 300 }, (_, i) => item(`u-${i}`, 'R', 20, 20, {
      legendTypeCode: undefined,
      type: 'receptacle',
      name: 'unknown receptacle',
      matchConfidence: 'low',
    }));
    const analysis = e100Analysis([...matching, ...unresolved]);
    analysis.legendTypeCounts = { A: 80 };
    const result = countItemsFromAnalysis(analysis, 'Type A');
    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(10_000);
    expect(result.unresolvedTruncated).toBe(true);
    expect((result.unresolvedItems || []).length).toBeLessThanOrEqual(40);
  });
});

describe('legend column split + extra keywords (fix 2)', () => {
  it('parses E-100 legend lines including EXIT/EMERGENCY/SWITCH vocabulary', () => {
    const entries = parseLegendFromTextLines(E100_LEGEND_LINES);
    expect(entries.map(e => e.typeCode)).toEqual(expect.arrayContaining(['A', 'B', 'EX1', 'ER1', 'S']));
  });

  it('splits a y-aligned schedule row from far-right plan text', () => {
    const lines = groupTextIntoColumnLines([
      { str: 'TYPE', x: 10, y: 100, width: 20, height: 8 },
      { str: 'A', x: 40, y: 100, width: 10, height: 8 },
      { str: '2x4 RECESSED', x: 60, y: 100, width: 80, height: 8 },
      { str: 'ROOM 101', x: 400, y: 100, width: 50, height: 8 },
    ]);
    expect(lines.some(line => /TYPE/.test(line) && /2x4/.test(line))).toBe(true);
    expect(lines.some(line => line === 'ROOM 101')).toBe(true);
  });
});

describe('unresolved items stay visible (fix 3)', () => {
  it('returns unresolvedItems without changing confirmed counts', () => {
    const analysis = e100Analysis([
      item('a1', 'A', 10, 10),
      item('low', 'A', 12, 12, { matchConfidence: 'low', notes: 'Low-confidence legend match: A' }),
      item('none', 'fixture', 14, 14, { legendTypeCode: 'no_confident_match' }),
    ]);
    analysis.legendTypeCounts = { A: 1 };
    const result = countItemsFromAnalysis(analysis, 'Type A');
    expect(result.total).toBe(1);
    expect(result.unresolvedItems?.some(i => i.id === 'low')).toBe(true);
    expect(result.unresolvedItems?.some(i => i.id === 'none')).toBe(true);
    expect(result.unresolvedCountByType?.A).toBe(1);
  });
});

describe('tile grid + reconcile (fix 4)', () => {
  it('sizes a 36x24in sheet to more than 3x3 (target ~150 DPI after 768px provider resize)', () => {
    const grid = visionTileGridForPage(36 * 72, 24 * 72);
    expect(grid.rows * grid.cols).toBeGreaterThan(9);
    expect(grid.rows * grid.cols).toBeLessThanOrEqual(16);
  });

  it('keeps overlapping-tile boundary copies and merges by legendTypeCode + distance', () => {
    const [left, middle] = generateOverlappingTileRegions(900, 600).slice(0, 2);
    const pageX = 300;
    const pageY = 100;
    const local = (region: typeof left) => ({
      x: ((pageX - region.x) / region.width) * 100,
      y: ((pageY - region.y) / region.height) * 100,
    });
    const leftLocal = local(left);
    const middleLocal = local(middle);
    const createResult = (items: DetectedItem[]): BlueprintAnalysisResult => ({
      page: 1, items, dimensions: [], text: [], symbols: [],
    });
    const items = reconcileTileDetections([
      {
        region: left,
        result: createResult([item('left-copy', 'EX1', leftLocal.x, leftLocal.y, { matchConfidence: 'medium' })]),
      },
      {
        region: middle,
        result: createResult([item('middle-copy', 'EX1', middleLocal.x, middleLocal.y, { confidence: 0.99 })]),
      },
    ], 900, 600);
    expect(items).toHaveLength(1);
  });
});

describe('quantity and missing location (fix 5)', () => {
  it('splits quantity 3 through real vision-native classification and counts 3', () => {
    const [region] = generateOverlappingTileRegions(612, 792, 1, 1);
    const mapped = mapTileItemToPage(item('group', 'A', 40, 40, {
      quantity: 3,
      legendTypeCode: 'A',
      matchConfidence: 'high',
    }), region, 612, 792);
    expect(mapped).toHaveLength(3);
    expect(mapped.every(row => row.quantity === 1)).toBe(true);
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    const classified = resolveLegendAwareCounting({
      items: mapped,
      legendEntries: legend,
      trade: 'electrical',
      applyTokenOverlapFallback: applyLegendAwareCounting,
    });
    expect(classified.legendTypeCounts.A).toBe(3);
    const counted = countItemsFromAnalysis({
      page: 1,
      items: classified.items,
      dimensions: [],
      text: [],
      symbols: [],
      legendTypeCodes: legend.map(e => e.typeCode),
      legendTypeCounts: classified.legendTypeCounts,
      countReliability: classified.reliability,
    }, 'Type A');
    expect(counted.total).toBe(3);
  });

  it('items with locationMissing appear in unresolvedItems without a notes text match', () => {
    const analysis = e100Analysis([
      item('ghost', 'A', 0, 0, { locationMissing: true }),
      item('real', 'A', 12, 12, { notes: 'tag has no location label' }),
    ]);
    analysis.legendTypeCounts = { A: 1 };
    const result = countItemsFromAnalysis(analysis, 'Type A');
    expect(result.unresolvedItems?.some(i => i.id === 'ghost' && i.reason === 'no location')).toBe(true);
    expect(result.unresolvedItems?.some(i => i.id === 'real' && i.reason === 'no location')).toBe(false);
  });
});

describe('tile reconcile ownership and absolute radius', () => {
  it('never merges two same-tile fixtures 0.5in apart', () => {
    const [region] = generateOverlappingTileRegions(36 * 72, 24 * 72, 2, 8);
    const inch = 72;
    const items = reconcileTileDetections([{
      region,
      result: {
        page: 1,
        items: [
          item('a', 'A', 10, 10),
          item('b', 'A', 10 + (0.5 * inch / region.width) * 100, 10),
        ],
        dimensions: [],
        text: [],
        symbols: [],
      },
    }], 36 * 72, 24 * 72);
    expect(items.filter(row => !row.locationMissing)).toHaveLength(2);
    expect(TILE_MERGE_RADIUS_PT).toBe(18);
  });

  it('keeps different-code symbols that are close together', () => {
    const [region] = generateOverlappingTileRegions(612, 792, 1, 1);
    const items = reconcileTileDetections([{
      region,
      result: {
        page: 1,
        items: [
          item('a', 'A', 50, 50),
          item('b', 'B', 50.2, 50.2),
        ],
        dimensions: [],
        text: [],
        symbols: [],
      },
    }], 612, 792);
    expect(items).toHaveLength(2);
  });
});
