/**
 * Cross-sheet legends: plan sheets often carry no fixture schedule of their own (it lives on a
 * legend/schedule sheet such as E-001 or E-2.1). When a page has no usable legend, find the
 * schedule/legend sheet in the same document via the project index and borrow its entries.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { allIndexedPages } from '../projectIndex/store';
import type { IndexedPageRecord } from '../projectIndex/types';
import type { LegendEntry } from './legendAwareCounting';
import { extractZoneInputs, type ZoneTextItem } from './pageZones';

const LIGHTING_SCHEDULE_RE = /\b(LIGHT(ING)?\s+FIXTURE|LUMINAIRE|FIXTURE)\s+SCHEDULE\b/i;
const LEGEND_RE = /\b(SYMBOLS?\s+LEGEND|ELECTRICAL\s+LEGEND|LIGHTING\s+LEGEND|LEGEND\s+(AND|&)\s+(SCHEDULES?|ABBREVIATIONS))\b/i;

export type SheetLegend = {
  entries: LegendEntry[];
  sourcePages: number[];
  sourceLabel: string;
  /** Read from the page's own schedule table (not borrowed from another sheet). */
  ownPage?: boolean;
};

const cache = new Map<string, Promise<SheetLegend | null>>();

function pageText(row: IndexedPageRecord): string {
  return row.text || (row.lines || []).map(line => line.text).join('\n');
}

function disciplineOf(row: IndexedPageRecord | undefined): string | undefined {
  return row?.discipline || row?.sheetNumber?.match(/^([A-Z]{1,2})/i)?.[1]?.toUpperCase();
}

/** Candidate legend/schedule pages for `page`, best first (same discipline, lighting schedule, nearby). */
export function findLegendPages(docId: string, page: number, limit = 2): number[] {
  const rows = allIndexedPages().filter(row => row.docId === docId && row.kind !== 'spec');
  const target = rows.find(row => row.page === page);
  const discipline = disciplineOf(target);
  const scored = rows
    .filter(row => row.page !== page)
    .map(row => {
      const text = pageText(row);
      const title = `${row.sheetTitle || ''} ${row.label || ''}`;
      let score = 0;
      if (LIGHTING_SCHEDULE_RE.test(text)) score += 6;
      if (LEGEND_RE.test(text)) score += 3;
      if (/LEGEND|SCHEDULE|SYMBOL/i.test(title)) score += 3;
      if (row.zones?.some(zone => zone.kind === 'schedule' || zone.kind === 'legend')) score += 1;
      if (score === 0) return null;
      const rowDiscipline = disciplineOf(row);
      if (discipline && rowDiscipline && rowDiscipline !== discipline) score -= 5;
      // Prefer the legend sheet that precedes the plans, then distance.
      score -= Math.min(4, Math.abs(row.page - page) / 10);
      if (row.page < page) score += 0.5;
      return { page: row.page, score };
    })
    .filter((row): row is { page: number; score: number } => !!row && row.score > 2)
    .sort((a, b) => b.score - a.score || a.page - b.page);
  return scored.slice(0, limit).map(row => row.page);
}

/**
 * Fixture types for `page`: this sheet's own schedule table if it has one, else the document's
 * legend/schedule sheet(s). Cached per doc revision.
 */
export function loadSheetLegend(
  pdfDoc: PDFDocumentProxy,
  docId: string,
  page: number,
  revision = 0,
): Promise<SheetLegend | null> {
  const key = `${docId}:${revision}:${page}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const readTable = async (p: number): Promise<LegendEntry[]> => {
        try {
          const { textItems } = await extractZoneInputs(await pdfDoc.getPage(p));
          return parseScheduleTables(textItems);
        } catch (error) {
          console.warn('[legend] could not read schedule on page', p, error);
          return [];
        }
      };
      const own = await readTable(page);
      if (own.length >= 2) return { entries: own, sourcePages: [page], sourceLabel: 'this sheet', ownPage: true };
      const entries: LegendEntry[] = [...own];
      const seen = new Set(own.map(entry => entry.typeCode));
      const used: number[] = [];
      for (const legendPage of findLegendPages(docId, page)) {
        const parsed = await readTable(legendPage);
        if (!parsed.length) continue;
        used.push(legendPage);
        for (const entry of parsed) {
          if (seen.has(entry.typeCode)) continue;
          seen.add(entry.typeCode);
          entries.push(entry);
        }
      }
      if (!used.length) return own.length ? { entries: own, sourcePages: [page], sourceLabel: 'this sheet', ownPage: true } : null;
      const rows = allIndexedPages().filter(row => row.docId === docId && used.includes(row.page));
      const sourceLabel = used
        .map(p => {
          const sheet = rows.find(row => row.page === p)?.sheetNumber;
          return sheet ? `${sheet} (page ${p})` : `page ${p}`;
        })
        .join(', ');
      return { entries, sourcePages: used, sourceLabel, ownPage: false };
    })();
    cache.set(key, pending);
    if (cache.size > 48) cache.delete(cache.keys().next().value as string);
  }
  return pending;
}

/**
 * The schedule-table reader is precise (codes from the TYPE/MARK column only), so whenever it
 * finds a real schedule (2+ types) use it; the page-text parser picks up panel / note codes.
 */
export function mergeLegendEntries(pageEntries: LegendEntry[], sheet: SheetLegend | null): LegendEntry[] {
  if (!sheet || sheet.entries.length < 2) return pageEntries;
  return sheet.entries;
}

const SCHEDULE_TITLE_RE = /\b(LUMINAIRE|LIGHT(ING)?\s+FIXTURE|FIXTURE|LIGHTING)\s+SCHEDULE\b/i;
const TYPE_HEADER_RE = /^(FIXTURE\s+)?(TYPE|MARK|TAG|SYMBOL|DESIGNATION|LABEL|ID)\.?$/i;
const CODE_RE = /^[A-Z]{1,3}\d{0,2}[A-Z]?(?:[-/][A-Z0-9]{1,4})?$/;
const STOP_RE = /^(NOTES?|GENERAL\s+NOTES?|REMARKS)\b/i;

const glyph = (item: ZoneTextItem) => item.fontHeight || item.height || 8;
const cy = (item: ZoneTextItem) => item.y + item.height / 2;

/**
 * Read luminaire / fixture schedule tables on a legend sheet (display coordinates): find the
 * schedule title, the TYPE/MARK column header below it, then the codes down that column with
 * the rest of each row as the description. Ignores general notes that merely mention a schedule.
 */
export function parseScheduleTables(items: ZoneTextItem[]): LegendEntry[] {
  const text = items.filter(item => !item.vertical && item.str.trim());
  const titles = text.filter(item => {
    const str = item.str.trim();
    return SCHEDULE_TITLE_RE.test(str) && str.length <= 40 && !/^SEE\b|\bSEE\s/i.test(str);
  });
  const out = new Map<string, LegendEntry>();
  for (const title of titles) {
    const unit = glyph(title);
    const headers = text
      .filter(item => TYPE_HEADER_RE.test(item.str.trim())
        && item.y > title.y
        && item.y - title.y < Math.max(80, unit * 6)
        && Math.abs(item.x - title.x) < 700)
      .sort((a, b) => (a.y - title.y) - (b.y - title.y) || Math.abs(a.x - title.x) - Math.abs(b.x - title.x));
    const header = headers[0];
    if (!header) continue;
    const rowTol = Math.max(3, glyph(header) * 0.6);
    const headerRow = text
      .filter(item => Math.abs(cy(item) - cy(header)) <= rowTol && item.x >= header.x - 10)
      .sort((a, b) => a.x - b.x);
    // Table extent: contiguous header cells to the right of TYPE.
    let tableX1 = header.x + header.width;
    for (const cell of headerRow) {
      if (cell.x - tableX1 > 400) break;
      tableX1 = Math.max(tableX1, cell.x + cell.width);
    }
    const nextHeader = headerRow.find(cell => cell !== header && cell.x > header.x + header.width);
    const colX0 = header.x - Math.max(20, glyph(header) * 2);
    const colX1 = nextHeader ? nextHeader.x - 2 : header.x + header.width + 60;
    const descHeader = headerRow.find(cell => /DESCRIPTION/i.test(cell.str));
    const below = text
      .filter(item => item.y > header.y + glyph(header) * 0.5 && item.x >= colX0 && item.x <= tableX1 + 40)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    let lastY = header.y;
    for (const item of below) {
      const headerCenter = header.x + header.width / 2;
      const center = item.x + item.width / 2;
      const inCol = item.x >= colX0 && center <= colX1
        && Math.abs(center - headerCenter) <= Math.max(header.width * 1.2, glyph(header) * 4);
      if (!inCol) continue;
      const str = item.str.trim().replace(/[.:]$/, '');
      if (STOP_RE.test(str)) break;
      if (item.y - lastY > Math.max(60, glyph(header) * 8)) break;
      if (!CODE_RE.test(str.toUpperCase()) || /^(LED|TYPE|MFR|NO|EA)$/i.test(str)) continue;
      lastY = item.y;
      const rowItems = text
        .filter(cell => cell !== item && Math.abs(cy(cell) - cy(item)) <= Math.max(3, glyph(item) * 0.7)
          && cell.x > item.x && cell.x <= tableX1 + 40)
        .sort((a, b) => a.x - b.x);
      const preferred = descHeader
        ? rowItems.filter(cell => cell.x + cell.width >= descHeader.x - 40)
        : rowItems;
      const description = (preferred.length ? preferred : rowItems)
        .slice(0, 3)
        .map(cell => cell.str.trim())
        .join(' ')
        .slice(0, 100);
      const code = str.toUpperCase();
      if (!out.has(code)) out.set(code, { typeCode: code, description: description || code, source: 'schedule' });
    }
  }
  return [...out.values()];
}
