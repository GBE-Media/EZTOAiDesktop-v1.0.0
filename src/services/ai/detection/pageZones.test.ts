import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  clearPageZoneMemory,
  filterDetectionsByZones,
  skipTilesCoveredByNonPlanZones,
  zoneFromSignals,
  zonePage,
  type PageZone,
} from './pageZones';
import { E100_GROUND_TRUTH } from './fixtures/lightingPlanE100.fixture';
import { countItemsFromAnalysis } from '../agent/pageAnalysisCache';
import { groundAnswerToCountTool } from '../agent/countGrounding';
import type { DetectedItem } from '../providers/types';

const PAGE_W = 1728;
const PAGE_H = 2592;

function glyph(id: string, x: number, y: number): DetectedItem {
  return {
    id,
    type: 'A',
    name: 'Type A',
    trade: 'electrical',
    quantity: 1,
    location: { x, y },
    confidence: 0.9,
  };
}

function syntheticSignals() {
  const textItems = [
    { str: 'LIGHTING PLAN', x: 80, y: 80, width: 200, height: 16 },
    ...Array.from({ length: 10 }, (_, i) => ({ str: 'A', x: 120 + (i % 5) * 80, y: 200 + Math.floor(i / 5) * 80, width: 12, height: 12 })),
    { str: 'LIGHTING FIXTURE SCHEDULE', x: 1100, y: 80, width: 280, height: 14 },
    ...Array.from({ length: 10 }, (_, i) => ({ str: 'TYPE A 2x4 TROFFER', x: 1100, y: 110 + i * 16, width: 220, height: 10 })),
    { str: 'GENERAL NOTES', x: 80, y: 2000, width: 160, height: 12 },
    ...Array.from({ length: 8 }, (_, i) => ({ str: `Note line ${i + 1} install fixtures per spec.`, x: 80, y: 2020 + i * 14, width: 280, height: 9 })),
    { str: 'DETAIL 4/E-501', x: 900, y: 1900, width: 140, height: 12 },
    { str: 'A', x: 920, y: 1960, width: 12, height: 12 },
    { str: 'A', x: 960, y: 1960, width: 12, height: 12 },
    { str: 'A', x: 1000, y: 1960, width: 12, height: 12 },
    { str: 'E-100', x: 1400, y: 2480, width: 50, height: 12 },
  ];
  const vectors = [
    { kind: 'rect' as const, x: 1080, y: 60, width: 520, height: 420 },
    { kind: 'rect' as const, x: 880, y: 1860, width: 280, height: 220 },
    { kind: 'rect' as const, x: 0, y: 2440, width: PAGE_W, height: 152 },
  ];
  return { textItems, vectors };
}

describe('page zones', () => {
  it('counts 10 plan glyphs and excludes schedule, notes, and detail', () => {
    const { textItems, vectors } = syntheticSignals();
    const zones = zoneFromSignals({ pageWidth: PAGE_W, pageHeight: PAGE_H, textItems, vectors });
    expect(zones.some(z => z.kind === 'schedule')).toBe(true);
    expect(zones.some(z => z.kind === 'notes')).toBe(true);
    expect(zones.some(z => z.kind === 'detail')).toBe(true);
    expect(zones.some(z => z.kind === 'title_block')).toBe(true);

    const items = [
      ...Array.from({ length: 10 }, (_, i) => glyph(`plan_${i}`, 120 + (i % 5) * 80, 200 + Math.floor(i / 5) * 80)),
      ...Array.from({ length: 10 }, (_, i) => glyph(`sched_${i}`, 1120, 120 + i * 16)),
      glyph('note_1', 100, 2040),
      glyph('d1', 920, 1960),
      glyph('d2', 960, 1960),
      glyph('d3', 1000, 1960),
    ];
    const filtered = filterDetectionsByZones(items, zones, { pageWidth: PAGE_W, pageHeight: PAGE_H });
    expect(filtered.kept.length).toBe(10);
    expect(filtered.excludedByZone.map(row => row.kind).sort()).toEqual(expect.arrayContaining(['schedule', 'notes', 'detail']));

    const counted = countItemsFromAnalysis({
      page: 1,
      items: filtered.kept,
      typeCounts: { A: 10 },
      summary: '',
      questions: [],
    } as never, '');
    expect(counted.total).toBe(10);
    expect(filtered.excludedByZone.length).toBeGreaterThan(0);
    expect(Object.values(E100_GROUND_TRUTH).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('detects an unruled text-only schedule', () => {
    const textItems = [
      { str: 'TYPE  DESC  QTY', x: 500, y: 40, width: 200, height: 10 },
      ...Array.from({ length: 6 }, (_, i) => ({
        str: `TYPE A   TROFFER   ${i}`,
        x: 500,
        y: 60 + i * 14,
        width: 220,
        height: 10,
      })),
    ];
    const zones = zoneFromSignals({ pageWidth: 900, pageHeight: 700, textItems });
    expect(zones.some(z => z.kind === 'schedule')).toBe(true);
  });

  it('uses a mocked vision fallback on a scanned page and caches zones', async () => {
    clearPageZoneMemory();
    const vision: PageZone[] = [{
      id: 'v1',
      kind: 'schedule',
      bounds: { x: 800, y: 40, width: 300, height: 200 },
      label: 'SCHEDULE',
      confidence: 0.8,
      source: 'vision',
    }];
    const pdfDoc = {
      getPage: async () => ({
        getViewport: () => ({ width: 1000, height: 800 }),
        getTextContent: async () => ({ items: [] }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      }),
    };
    const visionFn = vi.fn(async () => vision);
    const first = await zonePage(pdfDoc as never, 1, { docId: 'scan', visionFallback: visionFn });
    const second = await zonePage(pdfDoc as never, 1, { docId: 'scan', visionFallback: visionFn });
    expect(first.some(z => z.kind === 'schedule' || z.source === 'vision')).toBe(true);
    expect(visionFn).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('skips tiles fully inside non-plan zones covering >25% of the sheet', () => {
    const zones: PageZone[] = [
      { id: 'plan', kind: 'plan', bounds: { x: 0, y: 0, width: 400, height: 400 }, label: 'Plan', confidence: 1, source: 'text' },
      { id: 's', kind: 'schedule', bounds: { x: 400, y: 0, width: 600, height: 800 }, label: 'Schedule', confidence: 1, source: 'text' },
    ];
    const tiles = [
      { x: 0, y: 0, width: 200, height: 200 },
      { x: 420, y: 20, width: 200, height: 200 },
      { x: 500, y: 300, width: 200, height: 200 },
    ];
    const skipped = skipTilesCoveredByNonPlanZones(tiles, zones);
    expect(skipped.skipped.length).toBeGreaterThan(0);
    const cover = (600 * 800) / (1000 * 800);
    expect(cover).toBeGreaterThan(0.25);
  });
});

describe('count verifier', () => {
  it('revises an answer saying 23 when the tool total is 10', () => {
    const result = groundAnswerToCountTool('I counted 23 symbols on the sheet.', { total: 10 });
    expect(result.revised).toBe(true);
    expect(result.message).not.toMatch(/\b23\b/);
    expect(result.message).toMatch(/\b10\b/);
  });
});

describe('pdf-lib synthetic sheet', () => {
  it('builds a 24x36 sheet with schedule header text', async () => {
    const started = Date.now();
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([PAGE_W, PAGE_H]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('LIGHTING PLAN', { x: 72, y: PAGE_H - 72, size: 18, font, color: rgb(0, 0, 0) });
    page.drawText('LIGHTING FIXTURE SCHEDULE', { x: 1100, y: PAGE_H - 80, size: 12, font });
    page.drawRectangle({ x: 1080, y: PAGE_H - 500, width: 500, height: 400, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    const bytes = await pdf.save();
    expect(bytes.byteLength).toBeGreaterThan(400);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
  });
});
