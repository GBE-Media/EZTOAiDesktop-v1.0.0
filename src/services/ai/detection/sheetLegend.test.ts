import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { rebindCachedPages } from '../projectIndex/store';
import type { IndexedPageRecord } from '../projectIndex/types';
import type { ZonePageInput, ZoneTextItem } from './pageZones';

const fixture = (name: string): ZonePageInput => JSON.parse(gunzipSync(readFileSync(
  path.resolve(__dirname, '../../../test/fixtures/zones', `${name}.json.gz`),
)).toString());

const cell = (x: number, y: number, str: string, h = 8): ZoneTextItem => ({ str, x, y, width: str.length * h * 0.6, height: h, fontHeight: h });
const LEGEND_SHEET: ZoneTextItem[] = [
  cell(900, 380, 'SEE LIGHT FIXTURE SCHEDULE FOR TYPES'),
  cell(100, 100, 'LIGHT FIXTURE SCHEDULE', 16),
  cell(100, 130, 'TYPE'), cell(160, 130, 'DESCRIPTION'), cell(400, 130, 'MANUFACTURER'), cell(520, 130, 'VOLTS'),
  cell(102, 150, 'A'), cell(160, 150, '2X4 LED TROFFER'), cell(400, 150, 'LITHONIA'), cell(520, 150, '277'),
  cell(102, 165, 'B1'), cell(160, 165, '6" LED DOWNLIGHT'), cell(400, 165, 'GOTHAM'), cell(520, 165, '277'),
  cell(102, 180, 'XA'), cell(160, 180, 'EXIT SIGN EDGE LIT'), cell(400, 180, 'LITHONIA'), cell(520, 180, '120'),
  cell(100, 200, 'NOTES:'), cell(102, 215, 'C'), cell(160, 215, 'ALL FIXTURES SHALL BE UL LISTED'),
];

vi.mock('./pageZones', async importOriginal => ({
  ...(await importOriginal<typeof import('./pageZones')>()),
  extractZoneInputs: vi.fn(async (page: { n: number }) => ({
    pageWidth: 1000, pageHeight: 700, textItems: page.n === 92 ? LEGEND_SHEET : [cell(300, 300, 'A'), cell(320, 300, 'B1')],
  })),
}));

import { findLegendPages, loadSheetLegend, mergeLegendEntries, parseScheduleTables } from './sheetLegend';

const indexed = (p: number, extra: Partial<IndexedPageRecord>): IndexedPageRecord => ({
  docId: 'doc_full', docFp: 'fp_full', documentName: 'FULL-PLANSET-REV1.pdf', page: p,
  lines: [], kind: 'drawing', needsOcr: false, ...extra,
} as IndexedPageRecord);

rebindCachedPages('fp_msu', 'doc_msu', 'MSU.pdf', [
  { ...indexed(2, { sheetNumber: 'E001', sheetTitle: 'ELECTRICAL COVER SHEET', text: 'ELECTRICAL SYMBOLS' }), docId: 'doc_msu', docFp: 'fp_msu' },
  { ...indexed(9, { sheetNumber: 'E002', sheetTitle: 'ELECTRICAL LEGEND', text: 'ELECTRICAL LEGEND LIGHT FIXTURE SCHEDULE' }), docId: 'doc_msu', docFp: 'fp_msu' },
  { ...indexed(10, { sheetNumber: 'E100', sheetTitle: 'LIGHTING PLAN', text: 'CONTROLS. SEE SHEET E001 FOR LUMINAIRE SCHEDULE AND LIGHTING' }), docId: 'doc_msu', docFp: 'fp_msu' },
]);
rebindCachedPages('fp_full', 'doc_full', 'FULL-PLANSET-REV1.pdf', [
  indexed(12, { sheetNumber: 'M-2.1', sheetTitle: 'MECHANICAL SCHEDULES', text: 'EQUIPMENT SCHEDULE' }),
  indexed(92, { sheetNumber: 'E-2.1', sheetTitle: 'ELECTRICAL LEGEND AND SCHEDULES', text: 'ELECTRICAL LEGEND LIGHT FIXTURE SCHEDULE' }),
  indexed(93, { sheetNumber: 'E-3', sheetTitle: 'FIRST AND SECOND FLOOR ELECTRICAL PLANS', text: 'A A B1 XA' }),
  indexed(94, { sheetNumber: 'E-4', sheetTitle: 'THIRD AND FOURTH FLOOR ELECTRICAL PLANS', text: 'A B1' }),
]);

const pdfDoc = { getPage: async (n: number) => ({ n }) } as never;

describe('schedule table reader', () => {
  it('reads only the TYPE column under the schedule title, stopping at notes', () => {
    const entries = parseScheduleTables(LEGEND_SHEET);
    expect(entries.map(e => e.typeCode)).toEqual(['A', 'B1', 'XA']);
    expect(entries[0].description).toMatch(/TROFFER/);
  });

  it('reads the real Otsego E210 luminaire schedule (rotated sheet)', () => {
    const codes = parseScheduleTables(fixture('otsego_E210').textItems).map(e => e.typeCode);
    expect(codes).toEqual(expect.arrayContaining(['A', 'PA', 'RA', 'RB', 'RC', 'TA', 'TB']));
    expect(codes).not.toContain('DMX');
  });

  it('reads the Library EL-201 schedule, whose marks are left-aligned under a centred MARK header', () => {
    const entries = parseScheduleTables(fixture('library_EL201').textItems);
    const codes = entries.map(e => e.typeCode);
    expect(codes).toEqual(expect.arrayContaining(['A', 'B', 'B1', 'C', 'D', 'E2', 'H', 'J', 'JE', 'M', 'X2C']));
    expect(codes).not.toContain('OCL');
    expect(codes).not.toContain('HALO');
    expect(entries.find(e => e.typeCode === 'E2')?.description).toContain('METALUX');
  });
});

describe('cross-sheet legend', () => {
  it('follows "SEE SHEET E001 FOR LUMINAIRE SCHEDULE" to that sheet (MSU E100)', () => {
    expect(findLegendPages('doc_msu', 10)[0]).toBe(2);
  });

  it('finds the electrical legend/schedule sheet for a plan sheet', () => {
    expect(findLegendPages('doc_full', 93)[0]).toBe(92);
    expect(findLegendPages('doc_full', 94)[0]).toBe(92);
    expect(findLegendPages('doc_full', 93)).not.toContain(12);
  });

  it('borrows the legend sheet entries for a plan sheet without its own schedule', async () => {
    const legend = await loadSheetLegend(pdfDoc, 'doc_full', 93, 0);
    expect(legend?.entries.map(e => e.typeCode)).toEqual(['A', 'B1', 'XA']);
    expect(legend?.sourceLabel).toBe('E-2.1 (page 92)');
    expect(legend?.ownPage).toBe(false);
  });

  it('prefers a real schedule table over the noisy page parse', () => {
    const sheet = { entries: parseScheduleTables(LEGEND_SHEET), sourcePages: [92], sourceLabel: 'E-2.1' };
    expect(mergeLegendEntries([{ typeCode: 'DMX', description: 'DMX', source: 'text' }], sheet).map(e => e.typeCode)).toEqual(['A', 'B1', 'XA']);
    const noisy = ['R26/2620073', 'WP/GFCI', 'A-29', 'A', 'B1'].map(typeCode => ({ typeCode, description: typeCode, source: 'text' as const }));
    expect(mergeLegendEntries(noisy, sheet).map(e => e.typeCode)).toEqual(['A', 'B1', 'XA']);
    expect(mergeLegendEntries(noisy, { ...sheet, entries: sheet.entries.slice(0, 1) })).toBe(noisy);
  });
});
