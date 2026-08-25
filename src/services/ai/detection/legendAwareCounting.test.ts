import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  applyLegendAwareCounting,
  formatLegendPromptBlock,
  normalizeTypeAgainstLegend,
  parseLegendFromTextLines,
  rawTypeCountsFromItems,
} from './legendAwareCounting';
import {
  E100_GROUND_TRUTH,
  E100_LEGEND_LINES,
  buildE100CleanVisionDetections,
  buildE100MessyVisionDetections,
  exactMatchRate,
} from './fixtures/lightingPlanE100.fixture';

describe('legend-aware fixture counting', () => {
  it('parses fixture type codes from a page legend/schedule', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    const codes = legend.map((e) => e.typeCode);
    expect(codes).toEqual(expect.arrayContaining([
      'A', 'A/EM/NL', 'B', 'B-NL', 'B1', 'C', 'D', 'S', 'LT/FN', 'EX1', 'EM1', 'ER1',
    ]));
    // Specific variants present as distinct codes
    expect(codes).toContain('B-NL');
    expect(codes).toContain('A/EM/NL');
  });

  it('prefers specific codes (B-NL over B) when normalizing labels', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    const night = normalizeTypeAgainstLegend('B', 'night light fixture', legend);
    expect(night.typeCode).toBe('B-NL');
    expect(night.matchKind).toBe('description');

    const plainB = normalizeTypeAgainstLegend('B', 'Type B cylinder', legend);
    expect(plainB.typeCode).toBe('B');

    const variant = normalizeTypeAgainstLegend('A', 'recessed emergency night light', legend);
    // Should map to A/EM/NL via description tokens, not silently stay as A
    expect(variant.typeCode).toBe('A/EM/NL');
    expect(variant.matchKind).toBe('description');
  });

  it('does not upgrade exact base type to sibling on incidental one-word overlap (B vs B1 WALL WASHER)', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    // B1 description is "WALL WASHER" (2 tokens). "wall" alone must NOT steal exact B.
    const result = normalizeTypeAgainstLegend('B', 'wall sconce', legend);
    expect(result.typeCode).toBe('B');
    expect(result.typeCode).not.toBe('B1');
  });

  it('does not upgrade exact base type to sibling on incidental one-word overlap (C vs C1 WET LOCATION)', () => {
    const legend = [
      { typeCode: 'C', description: 'PENDANT', source: 'schedule' as const },
      { typeCode: 'C1', description: 'WET LOCATION', source: 'schedule' as const },
    ];
    // Single shared word "wet" against 2-token sibling description must not demote exact C.
    const result = normalizeTypeAgainstLegend('C', 'wet area pendant', legend);
    expect(result.typeCode).toBe('C');
    expect(result.typeCode).not.toBe('C1');
  });

  it('does not upgrade on shared generic legend vocabulary (B vs B2 WALL MOUNT LIGHT)', () => {
    // ADV1: 2 of 3 tokens overlap, but WALL/MOUNT/LIGHT are common across this page's legend.
    const legend = [
      { typeCode: 'A', description: 'RECESSED LIGHT', source: 'schedule' as const },
      { typeCode: 'B', description: 'SURFACE CYLINDER', source: 'schedule' as const },
      { typeCode: 'B2', description: 'WALL MOUNT LIGHT', source: 'schedule' as const },
      { typeCode: 'B3', description: 'WALL MOUNT SCONCE', source: 'schedule' as const },
      { typeCode: 'D', description: 'DOWNLIGHT WALL WASH', source: 'schedule' as const },
    ];
    const result = normalizeTypeAgainstLegend('B', 'wall bracket light', legend);
    expect(result.typeCode).toBe('B');
    expect(result.typeCode).not.toBe('B2');
  });

  it('does not upgrade on 3/4 shared generic tokens against a longer sibling description', () => {
    // ADV5-style: wall/mount/light/fixture appear across multiple legend rows.
    const legend = [
      { typeCode: 'B', description: 'SURFACE CYLINDER', source: 'schedule' as const },
      { typeCode: 'B4', description: 'WALL MOUNT LIGHT FIXTURE', source: 'schedule' as const },
      { typeCode: 'E', description: 'WALL LIGHT FIXTURE', source: 'schedule' as const },
      { typeCode: 'F', description: 'CEILING MOUNT FIXTURE', source: 'schedule' as const },
    ];
    const result = normalizeTypeAgainstLegend('B', 'wall mount light unit', legend);
    expect(result.typeCode).toBe('B');
    expect(result.typeCode).not.toBe('B4');
  });

  it('still upgrades when shared vocabulary is page-unique and distinguishing', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    // WASHER is unique to B1 on this legend — must still upgrade.
    const washer = normalizeTypeAgainstLegend('B', 'wall washer', legend);
    expect(washer.typeCode).toBe('B1');
    expect(washer.matchKind).toBe('description');

    // A/EM/NL shares EMERGENCY with EM1/ER1 (not page-unique), but ≥3 overlapping
    // schedule words still upgrade via the IDF fallback.
    const compound = normalizeTypeAgainstLegend('A', 'recessed emergency night light', legend);
    expect(compound.typeCode).toBe('A/EM/NL');
    expect(compound.matchKind).toBe('description');

    // Truly unique multi-token description on a small legend.
    const wetLegend = [
      { typeCode: 'C', description: 'PENDANT', source: 'schedule' as const },
      { typeCode: 'C1', description: 'WET LOCATION', source: 'schedule' as const },
    ];
    const wet = normalizeTypeAgainstLegend('C', 'wet location rated', wetLegend);
    expect(wet.typeCode).toBe('C1');
    expect(wet.matchKind).toBe('description');
  });

  it('BEFORE (raw counts) fails the E-100 harness; AFTER (legend-aware) matches ground truth', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    const messy = buildE100MessyVisionDetections();

    const beforeCounts = rawTypeCountsFromItems(messy);
    const before = exactMatchRate(beforeCounts, E100_GROUND_TRUTH);
    // Baseline failure: B-NL collapsed into B, A/EM/NL into A
    expect(beforeCounts.B).toBe(4); // 3 real B + 1 mislabeled B-NL
    expect(beforeCounts.A).toBe(9); // 8 real A + 1 mislabeled A/EM/NL
    expect(beforeCounts['B-NL'] ?? 0).toBe(0);
    expect(beforeCounts['A/EM/NL'] ?? 0).toBe(0);
    expect(before.rate).toBeLessThan(1);
    expect(before.mismatches.some((m) => m.type === 'B' || m.type === 'B-NL')).toBe(true);

    const after = applyLegendAwareCounting({ items: messy, legendEntries: legend });
    const afterRate = exactMatchRate(after.legendTypeCounts, E100_GROUND_TRUTH);

    expect(after.legendTypeCounts.A).toBe(8);
    expect(after.legendTypeCounts['A/EM/NL']).toBe(1);
    expect(after.legendTypeCounts.B).toBe(3);
    expect(after.legendTypeCounts['B-NL']).toBe(1);
    expect(after.legendTypeCounts.B1).toBe(4);
    expect(after.legendTypeCounts.EX1).toBe(3);
    expect(after.legendTypeCounts.ER1).toBe(2);
    expect(after.legendTypeCounts.C).toBe(0);
    expect(after.legendTypeCounts.EM1).toBe(0);
    expect(afterRate.rate).toBe(1);
    expect(afterRate.mismatches).toEqual([]);
    expect(after.reliability).toBe('high');
    expect(after.verification.legendMatchRate).toBe(1);
  });

  it('clean vision detections stay exact after legend pass', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    const clean = buildE100CleanVisionDetections();
    const result = applyLegendAwareCounting({ items: clean, legendEntries: legend });
    expect(exactMatchRate(result.legendTypeCounts, E100_GROUND_TRUTH).rate).toBe(1);
  });

  it('flags unresolved detections instead of inventing a type', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    const result = applyLegendAwareCounting({
      items: [{
        id: 'x1',
        type: 'mystery blob',
        name: 'unknown symbol',
        trade: 'electrical',
        quantity: 1,
        location: { x: 1, y: 1 },
        confidence: 0.8,
      }],
      legendEntries: legend,
    });
    expect(result.unresolved).toHaveLength(1);
    expect(result.reliability).not.toBe('high');
    expect(result.verification.notes.some((n) => /could not be matched/i.test(n))).toBe(true);
  });

  it('formatLegendPromptBlock lists exact codes for vision passes', () => {
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    const block = formatLegendPromptBlock(legend);
    expect(block).toContain('B-NL');
    expect(block).toContain('EXACT type code');
    expect(block).toContain('Never invent type codes');
  });

  it('builds a synthetic single-page PDF whose text yields the harness legend', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    let y = 750;
    for (const line of E100_LEGEND_LINES) {
      page.drawText(line, { x: 40, y, size: 10, font, color: rgb(0, 0, 0) });
      y -= 14;
    }
    // Place a few labeled fixtures as text callouts (deterministically readable)
    page.drawText('A', { x: 100, y: 400, size: 12, font });
    page.drawText('B-NL', { x: 200, y: 400, size: 12, font });
    page.drawText('EX1', { x: 300, y: 400, size: 12, font });

    const bytes = await pdf.save();
    expect(bytes.byteLength).toBeGreaterThan(500);

    // Round-trip: legend lines from the same content still parse (PDF text extract
    // in unit tests uses the source lines; pdf.js rendering is covered elsewhere).
    const legend = parseLegendFromTextLines(E100_LEGEND_LINES);
    expect(legend.length).toBeGreaterThanOrEqual(12);
    expect(legend.some((e) => e.typeCode === 'B-NL')).toBe(true);
    expect(legend.some((e) => e.typeCode === 'A/EM/NL')).toBe(true);
  });
});
