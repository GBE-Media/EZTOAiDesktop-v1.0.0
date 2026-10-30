import './agent/testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { generateOverlappingTileRegions, type PageTileRegion } from './imageCapture';
import { clearPageAnalysisCache } from './agent/pageAnalysisCache';
import { analyzePageMaximumAccuracy } from './pipeline';

const analyzeBlueprint = vi.hoisted(() => vi.fn());
const analyzeBlueprintWithModel = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
const capturePageVisionBundle = vi.hoisted(() => vi.fn());
const crossModel = vi.hoisted(() => ({ value: { provider: 'lovable', model: 'google/gemini-4-argon' } as { provider: string; model: string } | null }));

vi.mock('./aiService', () => ({
  getAIService: () => ({
    analyzeBlueprint,
    analyzeBlueprintWithModel,
    complete,
    getCrossCheckVisionModel: () => crossModel.value,
  }),
}));

vi.mock('./imageCapture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./imageCapture')>();
  return { ...actual, capturePageVisionBundle };
});

const LEGEND_ITEMS = [
  { str: 'LIGHTING', x: 20, y: 20, width: 60, height: 8 },
  { str: 'FIXTURE', x: 85, y: 20, width: 50, height: 8 },
  { str: 'SCHEDULE', x: 140, y: 20, width: 70, height: 8 },
  { str: 'TYPE', x: 20, y: 36, width: 28, height: 8 },
  { str: 'A', x: 52, y: 36, width: 12, height: 8 },
  { str: '-', x: 68, y: 36, width: 8, height: 8 },
  { str: '2x4 RECESSED LED TROFFER', x: 80, y: 36, width: 160, height: 8 },
];

const a = (id: string, x: number, y: number) => ({
  id, type: 'A', name: 'Type A', quantity: 1, confidence: 0.85,
  legendTypeCode: 'A', matchConfidence: 'high', location: { x, y },
});

function install(regions: PageTileRegion[]) {
  capturePageVisionBundle.mockResolvedValue({
    overview: { base64: 'overview', region: regions[0] },
    tiles: regions.map(region => ({ base64: region.id, region })),
  });
}

async function run() {
  return analyzePageMaximumAccuracy({
    pdfDoc: {} as PDFDocumentProxy,
    page: 1,
    pageWidth: 612,
    pageHeight: 792,
    trade: 'electrical',
    getCachedText: () => LEGEND_ITEMS,
  });
}

describe('second-opinion vision cross-check in the page pipeline', () => {
  beforeEach(() => {
    analyzeBlueprint.mockReset();
    analyzeBlueprintWithModel.mockReset();
    complete.mockReset();
    capturePageVisionBundle.mockReset();
    clearPageAnalysisCache();
    crossModel.value = { provider: 'lovable', model: 'google/gemini-4-argon' };
    complete.mockResolvedValue({ content: '{"questions":[],"evidence":[]}' });
  });

  it('re-reads every tile with the second model and keeps its extra find as a review marker', async () => {
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    install(regions);
    analyzeBlueprint.mockImplementation(async (image: string) => ({
      content: JSON.stringify({ items: image === 'overview' ? [] : [a('p1', 30, 30), a('p2', 60, 60)] }),
    }));
    analyzeBlueprintWithModel.mockImplementation(async () => ({
      content: JSON.stringify({ items: [a('s1', 30.2, 30.1), a('s2', 60, 60), a('s3', 80, 20)] }),
    }));
    const { analysis } = await run();
    expect(analyzeBlueprintWithModel).toHaveBeenCalledTimes(regions.length);
    expect(analyzeBlueprintWithModel.mock.calls[0][0]).toEqual({ provider: 'lovable', model: 'google/gemini-4-argon' });
    expect(analysis.visionCrossCheck).toMatchObject({ agreed: 2, secondOnly: 1, primaryOnly: 0 });
    expect(analysis.legendTypeCounts?.A).toBe(2);
    const review = analysis.items.find(i => i.crossCheck === 'second_only');
    expect(review?.matchConfidence).toBe('low');
    expect(analysis.countVerificationNotes?.some(n => /Second vision model/.test(n))).toBe(true);
  });

  it('skips the cross-check (totals unchanged) when the second model cannot read a tile', async () => {
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    install(regions);
    analyzeBlueprint.mockImplementation(async (image: string) => ({
      content: JSON.stringify({ items: image === 'overview' ? [] : [a('p1', 30, 30), a('p2', 60, 60)] }),
    }));
    analyzeBlueprintWithModel.mockRejectedValue(new Error('gateway 503'));
    const { analysis } = await run();
    expect(analysis.visionCrossCheck).toBeUndefined();
    expect(analysis.legendTypeCounts?.A).toBe(2);
    expect(analysis.items.every(i => !i.crossCheck)).toBe(true);
    expect(analysis.countVerificationNotes?.some(n => /check skipped/.test(n))).toBe(true);
  });

  it('runs no second model when the cross-check is off', async () => {
    crossModel.value = null;
    const regions = generateOverlappingTileRegions(612, 792, 1, 1);
    install(regions);
    analyzeBlueprint.mockImplementation(async (image: string) => ({
      content: JSON.stringify({ items: image === 'overview' ? [] : [a('p1', 30, 30)] }),
    }));
    const { analysis } = await run();
    expect(analyzeBlueprintWithModel).not.toHaveBeenCalled();
    expect(analysis.legendTypeCounts?.A).toBe(1);
  });
});
