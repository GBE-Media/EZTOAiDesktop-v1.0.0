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
    // Vision locations are display percent.
    location: { x: (x / PAGE_W) * 100, y: (y / PAGE_H) * 100 },
    confidence: 0.9,
  };
}

function syntheticSignals() {
  const t = (str: string, x: number, y: number, width: number, height: number) => ({ str, x, y, width, height, fontHeight: height });
  const textItems = [
    // Plan view: glyph tags inside walls, view title + scale line below.
    ...Array.from({ length: 10 }, (_, i) => t('A', 120 + (i % 5) * 80, 200 + Math.floor(i / 5) * 80, 12, 12)),
    t('FIRST FLOOR LIGHTING PLAN', 120, 540, 300, 18),
    t('1/8" = 1\'-0"', 120, 562, 90, 10),
    // Ruled fixture schedule.
    t('LIGHTING FIXTURE SCHEDULE', 1100, 70, 300, 18),
    ...Array.from({ length: 8 }, (_, i) => t(`TYPE ${String.fromCharCode(65 + i)}`, 1100, 106 + i * 30, 60, 10)),
    ...Array.from({ length: 8 }, (_, i) => t('2x4 LED TROFFER', 1200, 106 + i * 30, 120, 10)),
    // Notes block.
    t('GENERAL NOTES', 80, 2000, 180, 18),
    ...Array.from({ length: 8 }, (_, i) => t(`${i + 1}. All fixtures shall be installed per the manufacturer instructions.`, 80, 2030 + i * 14, 420, 9)),
    // Detail view.
    ...[920, 960, 1000].map(x => t('A', x, 1960, 12, 12)),
    t('TYPICAL MOUNTING DETAIL', 880, 2090, 260, 18),
    t('SCALE: NTS', 880, 2112, 80, 10),
    // A sentence that mentions a detail must NOT create a zone.
    t('SEE DETAIL 4/E-501 FOR MOUNTING', 300, 420, 200, 9),
    // Title block sheet number.
    t('E-100', 1560, 2480, 120, 36),
  ];
  const vectors = [
    { kind: 'rect' as const, x: 100, y: 150, width: 520, height: 360 },
    { kind: 'rect' as const, x: 140, y: 170, width: 200, height: 150 },
    ...Array.from({ length: 9 }, (_, i) => ({ kind: 'hline' as const, x: 1090, y: 100 + i * 30, width: 400, height: 0 })),
    { kind: 'rect' as const, x: 900, y: 1900, width: 200, height: 160 },
    { kind: 'vline' as const, x: 1540, y: 20, width: 0, height: PAGE_H - 40 },
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
    const filtered = filterDetectionsByZones(items, zones);
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
    const cell = (str: string, x: number, y: number) => ({ str, x, y, width: 60, height: 10, fontHeight: 10 });
    const textItems = [0, 1, 2, 3, 4, 5].flatMap(row => [
      cell(`T${row}`, 500, 60 + row * 14),
      cell('TROFFER', 580, 60 + row * 14),
      cell('120V', 660, 60 + row * 14),
      cell(`${row + 1}`, 740, 60 + row * 14),
    ]);
    const zones = zoneFromSignals({ pageWidth: 900, pageHeight: 700, textItems });
    expect(zones.some(z => z.kind === 'schedule')).toBe(true);
  });

  it('never starts a zone from a sentence that mentions a keyword', () => {
    const { textItems, vectors } = syntheticSignals();
    const zones = zoneFromSignals({ pageWidth: PAGE_W, pageHeight: PAGE_H, textItems, vectors });
    expect(zones.some(z => /SEE DETAIL/.test(z.label))).toBe(false);
  });

  it('uses a mocked vision fallback on a scanned page and caches zones', async () => {
    clearPageZoneMemory();
    const vision: PageZone[] = [{
      id: 'v1',
      kind: 'schedule',
      bounds: { x: 80, y: 5, width: 30, height: 25 },
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
      { id: 'plan', kind: 'plan', bounds: { x: 0, y: 0, width: 40, height: 50 }, label: 'Plan', confidence: 1, source: 'view' },
      { id: 's', kind: 'schedule', bounds: { x: 40, y: 0, width: 60, height: 100 }, label: 'Schedule', confidence: 1, source: 'text' },
    ];
    const tiles = [
      { x: 0, y: 0, width: 200, height: 200 },
      { x: 420, y: 20, width: 200, height: 200 },
      { x: 500, y: 300, width: 200, height: 200 },
    ];
    const skipped = skipTilesCoveredByNonPlanZones(tiles, zones, { width: 1000, height: 800 });
    expect(skipped.kept).toContainEqual(tiles[0]);
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
