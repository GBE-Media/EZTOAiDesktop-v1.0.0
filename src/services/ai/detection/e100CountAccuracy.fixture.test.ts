import '../agent/testGlobals';
import { describe, expect, it } from 'vitest';
import { countItemsFromAnalysis, parseMatchedLegendCodes } from '../agent/pageAnalysisCache';
import { generateOverlappingTileRegions, visionTileGridForPage } from '../imageCapture';
import { reconcileTileDetections } from '../pipeline';
import { groupTextIntoColumnLines } from '@/lib/pdfLoader';
import { parseLegendFromTextLines } from './legendAwareCounting';
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
  it('honors quantity > 1 when mapping/counting items', () => {
    const analysis = e100Analysis([
      item('group', 'A', 10, 10, { quantity: 3 }),
    ]);
    analysis.legendTypeCounts = { A: 3 };
    const result = countItemsFromAnalysis(analysis, 'Type A');
    expect(result.total).toBe(3);
    expect(result.matchingItems[0]?.quantity).toBe(3);
  });

  it('items noted as no location appear in unresolvedItems', () => {
    const analysis = e100Analysis([
      item('ghost', 'A', 0, 0, { notes: 'no location' }),
    ]);
    analysis.legendTypeCounts = { A: 0 };
    const result = countItemsFromAnalysis(analysis, 'Type A');
    expect(result.unresolvedItems?.some(i => i.reason === 'no location')).toBe(true);
  });
});
