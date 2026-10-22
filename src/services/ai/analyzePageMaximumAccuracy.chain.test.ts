import './agent/testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { generateOverlappingTileRegions, type PageTileRegion } from './imageCapture';
import {
  clearPageAnalysisCache,
  countItemsFromAnalysis,
  setCachedAnalyze,
} from './agent/pageAnalysisCache';
import { analyzePageMaximumAccuracy } from './pipeline';

const analyzeBlueprint = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
const capturePageVisionBundle = vi.hoisted(() => vi.fn());

vi.mock('./aiService', () => ({
  getAIService: () => ({
    analyzeBlueprint,
    complete,
  }),
}));

vi.mock('./imageCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./imageCapture')>();
  return {
    ...actual,
    capturePageVisionBundle,
  };
});

const pdfDoc = {} as PDFDocumentProxy;
const LEGEND_ITEMS = [
  { str: 'LIGHTING', x: 20, y: 20, width: 60, height: 8 },
  { str: 'FIXTURE', x: 85, y: 20, width: 50, height: 8 },
  { str: 'SCHEDULE', x: 140, y: 20, width: 70, height: 8 },
  { str: 'TYPE', x: 20, y: 36, width: 28, height: 8 },
  { str: 'A', x: 52, y: 36, width: 12, height: 8 },
  { str: '-', x: 68, y: 36, width: 8, height: 8 },
  { str: '2x4 RECESSED LED TROFFER', x: 80, y: 36, width: 160, height: 8 },
];

function jsonItem(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a1',
    type: 'A',
    name: 'Type A',
    quantity: 1,
    confidence: 0.9,
    legendTypeCode: 'A',
    matchConfidence: 'high',
    ...partial,
  };
}

function installCapture(regions: PageTileRegion[]) {
  capturePageVisionBundle.mockResolvedValue({
    overview: { base64: 'overview', region: regions[0] },
    tiles: regions.map(region => ({ base64: region.id, region })),
  });
}

function tileResponses(byTile: Record<string, Record<string, unknown>[]>, overview: Record<string, unknown>[] = []) {
  analyzeBlueprint.mockImplementation(async (image: string) => {
    if (image === 'overview') {
      return { content: JSON.stringify({ items: overview }) };
    }
    return { content: JSON.stringify({ items: byTile[image] || [] }) };
  });
}

async function runChain(options: {
  pageWidth: number;
  pageHeight: number;
  regions: PageTileRegion[];
  query?: string;
  textItems?: typeof LEGEND_ITEMS;
}) {
  const result = await analyzePageMaximumAccuracy({
    pdfDoc,
    page: 1,
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    trade: 'electrical',
    getCachedText: () => options.textItems || LEGEND_ITEMS,
  });
  setCachedAnalyze('chain|full', {
    status: 'completed',
    page: 1,
    scope: 'full',
    analysis: result.analysis,
    textEvidence: {
      source: result.textEvidence.source,
      confidence: result.textEvidence.confidence || 1,
      context: result.textEvidence.context,
      itemCount: result.analysis.items.length,
    },
  }, {
    docId: 'chain-doc',
    page: 1,
    scope: 'full',
    contentRevision: 0,
    promoteToLatestFull: true,
  });
  return countItemsFromAnalysis(result.analysis, options.query ?? 'Type A', { source: 'cache' });
}

describe('analyzePageMaximumAccuracy chain harness', () => {
  beforeEach(() => {
    analyzeBlueprint.mockReset();
    complete.mockReset();
    capturePageVisionBundle.mockReset();
    clearPageAnalysisCache();
    complete.mockResolvedValue({ content: '{"questions":[],"evidence":[]}' });
  });

  it('quantity 3 survives normalizeAnalysis and counts 3 stable ids', async () => {
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    installCapture(regions);
    tileResponses({
      [regions[0].id]: [jsonItem({ id: 'group', quantity: 3, location: { x: 40, y: 40 } })],
    });
    const counted = await runChain({ pageWidth: 612, pageHeight: 792, regions });
    expect(counted.total).toBe(3);
    expect(counted.matchingItems).toHaveLength(3);
    const ids = counted.matchingItems.map(row => row.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every(id => id.includes('#') || ids.length === 3)).toBe(true);
  });

  it('3 no-location + 1 real yields A=1 confirmed and 3 unresolved no location', async () => {
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    installCapture(regions);
    tileResponses({
      [regions[0].id]: [
        jsonItem({ id: 'ghost-1', location: {} }),
        jsonItem({ id: 'ghost-2' }),
        jsonItem({ id: 'ghost-3', location: { x: 'na', y: 'na' } }),
        jsonItem({ id: 'real', location: { x: 40, y: 50 } }),
      ],
    });
    const counted = await runChain({ pageWidth: 612, pageHeight: 792, regions });
    expect(counted.total).toBe(1);
    expect(counted.matchingItems).toHaveLength(1);
    expect(counted.unresolvedItems?.filter(row => row.reason === 'no location')).toHaveLength(3);
  });

  it('an item genuinely at (0,0) is still a real item', async () => {
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    installCapture(regions);
    tileResponses({
      [regions[0].id]: [jsonItem({ id: 'origin', location: { x: 0, y: 0 } })],
    });
    const counted = await runChain({ pageWidth: 612, pageHeight: 792, regions });
    expect(counted.total).toBe(1);
    expect(counted.unresolvedItems?.some(row => row.id.includes('origin'))).toBe(false);
    expect(counted.matchingItems[0].x).toBeDefined();
    expect(counted.matchingItems[0].y).toBeDefined();
  });

  it('4-tile corner counts 1 at 0 / 0.2 / 0.4 / 0.6in error', async () => {
    const pageW = 720;
    const pageH = 720;
    const regions = generateOverlappingTileRegions(pageW, pageH, 2, 2);
    installCapture(regions);
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
    for (const errIn of [0, 0.2, 0.4, 0.6]) {
      const err = errIn * 72;
      const byTile: Record<string, Record<string, unknown>[]> = {};
      regions.forEach((region, index) => {
        const pageX = 360 + dirs[index][0] * err;
        const pageY = 360 + dirs[index][1] * err;
        byTile[region.id] = [jsonItem({
          id: `corner-${index}`,
          location: {
            x: ((pageX - region.x) / region.width) * 100,
            y: ((pageY - region.y) / region.height) * 100,
          },
        })];
      });
      tileResponses(byTile);
      const counted = await runChain({ pageWidth: pageW, pageHeight: pageH, regions });
      expect(counted.total).toBe(1);
      expect(counted.matchingItems).toHaveLength(1);
    }
  });

  it('two real same-code fixtures 0.5in apart in one tile stay 2', async () => {
    const pageW = 720;
    const pageH = 720;
    const regions = generateOverlappingTileRegions(pageW, pageH, 1, 1);
    installCapture(regions);
    const region = regions[0];
    const inch = 0.5 * 72;
    tileResponses({
      [region.id]: [
        jsonItem({
          id: 'a',
          location: { x: 40, y: 40 },
        }),
        jsonItem({
          id: 'b',
          location: {
            x: 40 + (inch / region.width) * 100,
            y: 40,
          },
        }),
      ],
    });
    const counted = await runChain({ pageWidth: pageW, pageHeight: pageH, regions });
    expect(counted.total).toBe(2);
  });

  it('two real fixtures 0.5in apart across a seam stay 2', async () => {
    const pageW = 720;
    const pageH = 720;
    const regions = generateOverlappingTileRegions(pageW, pageH, 2, 2);
    installCapture(regions);
    const left = regions[0];
    const right = regions[1];
    const inch = 0.5 * 72;
    const leftPt = { x: 360 - inch / 2, y: 120 };
    const rightPt = { x: 360 + inch / 2, y: 120 };
    tileResponses({
      [left.id]: [jsonItem({
        id: 'l',
        location: {
          x: ((leftPt.x - left.x) / left.width) * 100,
          y: ((leftPt.y - left.y) / left.height) * 100,
        },
      })],
      [right.id]: [jsonItem({
        id: 'r',
        location: {
          x: ((rightPt.x - right.x) / right.width) * 100,
          y: ((rightPt.y - right.y) / right.height) * 100,
        },
      })],
    });
    const counted = await runChain({ pageWidth: pageW, pageHeight: pageH, regions });
    expect(counted.total).toBe(2);
  });

  it('owning tile misses q but has another A 0.75in away: both count', async () => {
    const pageW = 720;
    const pageH = 720;
    const regions = generateOverlappingTileRegions(pageW, pageH, 2, 2);
    installCapture(regions);
    const owner = regions.find(region => region.row === 1 && region.col === 1)!;
    const q = { x: 360, y: 360 };
    const otherA = { x: 360 + 0.75 * 72, y: 360 };
    const byTile: Record<string, Record<string, unknown>[]> = {};
    for (const region of regions) {
      if (region.id === owner.id) {
        byTile[region.id] = [jsonItem({
          id: 'a-near',
          location: {
            x: ((otherA.x - region.x) / region.width) * 100,
            y: ((otherA.y - region.y) / region.height) * 100,
          },
        })];
      } else {
        byTile[region.id] = [jsonItem({
          id: `q-${region.id}`,
          location: {
            x: ((q.x - region.x) / region.width) * 100,
            y: ((q.y - region.y) / region.height) * 100,
          },
        })];
      }
    }
    tileResponses(byTile);
    const counted = await runChain({ pageWidth: pageW, pageHeight: pageH, regions });
    expect(counted.total).toBe(2);
  });

  it('CODE DESCRIPTION schedule of 30 rows yields 30 legend codes', async () => {
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    installCapture(regions);
    tileResponses({ [regions[0].id]: [jsonItem({ id: 'a', location: { x: 40, y: 40 } })] });
    const textItems: typeof LEGEND_ITEMS = [
      { str: 'LIGHTING', x: 20, y: 20, width: 70, height: 8 },
      { str: 'FIXTURE', x: 95, y: 20, width: 60, height: 8 },
      { str: 'SCHEDULE', x: 160, y: 20, width: 80, height: 8 },
    ];
    for (let i = 1; i <= 30; i += 1) {
      const y = 20 + i * 12;
      textItems.push({ str: `T${i}`, x: 20, y, width: 22, height: 8 });
      textItems.push({ str: `2x4 RECESSED LED TROFFER ROW ${i}`, x: 50, y, width: 200, height: 8 });
    }
    const counted = await runChain({
      pageWidth: 612, pageHeight: 792, regions, query: 'Type T1', textItems,
    });
    expect(counted.legendTypeCodes).toHaveLength(30);
  });

  it('3-row A/B/EX1 legend yields 3 codes with normal reliability', async () => {
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    installCapture(regions);
    tileResponses({
      [regions[0].id]: [
        jsonItem({ id: 'a', legendTypeCode: 'A', type: 'A', location: { x: 20, y: 20 } }),
        jsonItem({ id: 'b', legendTypeCode: 'B', type: 'B', location: { x: 40, y: 20 } }),
        jsonItem({ id: 'ex', legendTypeCode: 'EX1', type: 'EX1', location: { x: 60, y: 20 } }),
      ],
    });
    const textItems: typeof LEGEND_ITEMS = [
      { str: 'LIGHTING', x: 20, y: 20, width: 70, height: 8 },
      { str: 'FIXTURE', x: 95, y: 20, width: 60, height: 8 },
      { str: 'SCHEDULE', x: 160, y: 20, width: 80, height: 8 },
      { str: 'A', x: 20, y: 36, width: 12, height: 8 },
      { str: '2x4 RECESSED TROFFER', x: 50, y: 36, width: 160, height: 8 },
      { str: 'B', x: 20, y: 50, width: 12, height: 8 },
      { str: 'CYLINDER DOWNLIGHT', x: 50, y: 50, width: 160, height: 8 },
      { str: 'EX1', x: 20, y: 64, width: 24, height: 8 },
      { str: 'EXIT SIGN', x: 50, y: 64, width: 80, height: 8 },
    ];
    const counted = await runChain({
      pageWidth: 612, pageHeight: 792, regions, query: '', textItems,
    });
    expect(counted.legendTypeCodes).toEqual(expect.arrayContaining(['A', 'B', 'EX1']));
    expect(counted.legendTypeCodes).toHaveLength(3);
    expect(counted.countReliability).not.toBe('low');
  });

  it('one failing tile continues with partial reliability naming the tile', async () => {
    const regions = generateOverlappingTileRegions(720, 720, 2, 2);
    installCapture(regions);
    analyzeBlueprint.mockImplementation(async (image: string) => {
      if (image === 'overview') return { content: JSON.stringify({ items: [] }) };
      if (image === 'r1c2') throw new Error('tile boom');
      return { content: JSON.stringify({ items: [jsonItem({ id: image, location: { x: 20, y: 20 } })] }) };
    });
    const counted = await runChain({ pageWidth: 720, pageHeight: 720, regions });
    expect(counted.countReliability).toBe('partial');
    expect(counted.verificationNotes?.some(note => /Tile\(s\) failed:.*r1c2/.test(note))).toBe(true);
    expect(counted.total).toBeGreaterThan(0);
  });

  it('shuffled tile completion order yields identical output', async () => {
    const regions = generateOverlappingTileRegions(720, 720, 2, 2);
    installCapture(regions);
    const byTile: Record<string, Record<string, unknown>[]> = {};
    regions.forEach((region, index) => {
      byTile[region.id] = [jsonItem({
        id: `det-${index}`,
        location: { x: 15 + index * 10, y: 20 + index * 8 },
      })];
    });
    const runWithDelays = async (delays: number[]) => {
      analyzeBlueprint.mockImplementation(async (image: string) => {
        if (image === 'overview') return { content: JSON.stringify({ items: [] }) };
        const index = regions.findIndex(region => region.id === image);
        await new Promise(resolve => setTimeout(resolve, delays[index] || 0));
        return { content: JSON.stringify({ items: byTile[image] || [] }) };
      });
      return runChain({ pageWidth: 720, pageHeight: 720, regions });
    };
    const first = await runWithDelays([40, 0, 25, 5]);
    const second = await runWithDelays([0, 35, 5, 20]);
    expect(first.matchingItems.map(row => row.id)).toEqual(second.matchingItems.map(row => row.id));
    expect(first.total).toBe(second.total);
  });
});
