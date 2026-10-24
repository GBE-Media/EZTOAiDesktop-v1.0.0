/**
 * Page zoning: tell the drawing views (plans) apart from schedules, legends,
 * notes, details, diagrams and the title block, so counts only use the plan.
 *
 * Coordinate space: zone `bounds` are in DISPLAY PERCENT (0–100 of the pdf.js
 * viewport at scale 1, including /Rotate) — the same space as vision detection
 * `location`s. Internally signals are in viewport points.
 *
 * Signals (native PDFs):
 *  - text items transformed through viewport.transform (rotation-correct)
 *  - vector segments from the operator list (constructPath + CTM)
 * Design rules (from real bid sets):
 *  - Only TITLE-FORM lines start zones ("KEYED NOTES", "LIGHT FIXTURE SCHEDULE"),
 *    never sentences that mention a keyword ("SEE DETAIL 4/E-501").
 *  - Text zones grow line-by-line and stop at the first paragraph break.
 *  - Drawing views are found from view titles (title + scale line) and the
 *    connected drawing content above them; demolition/photometric/detail views
 *    are excluded, plan views are counted.
 */
import { OPS, Util } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { allIndexedPages, rememberIndexedPages } from '../projectIndex/store';

export type PageZoneKind =
  | 'plan'
  | 'enlarged_plan'
  | 'demo_plan'
  | 'photometric'
  | 'schedule'
  | 'legend'
  | 'notes'
  | 'detail'
  | 'diagram'
  | 'title_block'
  | 'key_plan'
  | 'revisions';

export type PageZoneSource = 'text' | 'vector' | 'view' | 'vision' | 'sheet';

export type DocRect = { x: number; y: number; width: number; height: number };

export type PageZone = {
  id: string;
  kind: PageZoneKind;
  /** Display-percent rect (0–100). */
  bounds: DocRect;
  label: string;
  confidence: number;
  source: PageZoneSource;
};

export type ZoneVector = {
  kind: 'rect' | 'hline' | 'vline';
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ZoneTextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Glyph size (viewport points). Defaults to `height`. */
  fontHeight?: number;
  /** Rotated / vertical text (not used for headers). */
  vertical?: boolean;
};

export type ZonePageInput = {
  /** Viewport (display) size in points. */
  pageWidth: number;
  pageHeight: number;
  textItems: ZoneTextItem[];
  /** Legacy rect/line hints (viewport points). */
  vectors?: ZoneVector[];
  /** Flat [x1,y1,x2,y2,...] segments in viewport points. */
  segments?: ArrayLike<number>;
  visionZones?: PageZone[];
};

const COUNTED_KINDS: PageZoneKind[] = ['plan'];
const TEXT_ZONE_KINDS = new Set<PageZoneKind>(['schedule', 'legend', 'notes', 'title_block', 'key_plan', 'revisions']);
const zoneMemory = new Map<string, PageZone[]>();

/* ------------------------------------------------------------------ cache */

export function zoneCacheKey(docId: string, page: number, revision = 0): string {
  return `${docId}:${page}:${revision}`;
}

export function getCachedPageZones(docId: string, page: number, revision = 0): PageZone[] | null {
  const mem = zoneMemory.get(zoneCacheKey(docId, page, revision));
  if (mem) return mem;
  const indexed = allIndexedPages().find(row => row.docId === docId && row.page === page && row.zones?.length);
  return indexed?.zones || null;
}

export function setCachedPageZones(docId: string, page: number, zones: PageZone[], revision = 0): void {
  zoneMemory.set(zoneCacheKey(docId, page, revision), zones);
  const existing = allIndexedPages().filter(row => row.docId === docId);
  const match = existing.find(row => row.page === page);
  if (match) {
    const next = existing.map(row => row.page === page ? { ...row, zones } : row);
    rememberIndexedPages(docId, match.documentName, match.docFp, next);
  }
}

export function clearPageZoneMemory(): void {
  zoneMemory.clear();
}

/* ------------------------------------------------------------ extraction */

type Matrix = [number, number, number, number, number, number];

/** Rotation-correct text + vector segments for one page, in viewport points. */
export async function extractZoneInputs(page: PDFPageProxy): Promise<ZonePageInput> {
  const viewport = page.getViewport({ scale: 1 });
  const vt = viewport.transform as Matrix;
  const content = await page.getTextContent();
  const textItems: ZoneTextItem[] = [];
  for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
    if (!raw || typeof raw.str !== 'string' || !raw.str.trim() || !raw.transform) continue;
    const m = Util.transform(vt, raw.transform) as Matrix;
    const fs = Math.hypot(m[2], m[3]);
    const dirLen = Math.hypot(m[0], m[1]) || 1;
    const dx = m[0] / dirLen;
    const dy = m[1] / dirLen;
    const width = Number(raw.width) || raw.str.length * fs * 0.5;
    const ux = fs ? m[2] / fs : 0;
    const uy = fs ? m[3] / fs : -1;
    const xs = [m[4], m[4] + dx * width, m[4] + ux * fs, m[4] + dx * width + ux * fs];
    const ys = [m[5], m[5] + dy * width, m[5] + uy * fs, m[5] + dy * width + uy * fs];
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    textItems.push({
      str: raw.str,
      x: round1(minX),
      y: round1(minY),
      width: round1(Math.max(...xs) - minX),
      height: round1(Math.max(...ys) - minY),
      fontHeight: round1(fs),
      vertical: Math.abs(dy) > Math.abs(dx),
    });
  }
  const segments = await extractSegments(page, vt);
  return { pageWidth: viewport.width, pageHeight: viewport.height, textItems, segments };
}

const MAX_SEGMENTS = 200_000;

async function extractSegments(page: PDFPageProxy, vt: Matrix): Promise<number[]> {
  const out: number[] = [];
  try {
    const ops = await page.getOperatorList();
    const fns = ops.fnArray;
    const args = ops.argsArray as unknown[];
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    const push = (x1: number, y1: number, x2: number, y2: number) => {
      if (out.length >= MAX_SEGMENTS * 4) return;
      const m = Util.transform(vt, ctm) as Matrix;
      const a = applyMatrix(m, x1, y1);
      const b = applyMatrix(m, x2, y2);
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 0.5) return;
      out.push(round1(a[0]), round1(a[1]), round1(b[0]), round1(b[1]));
    };
    for (let i = 0; i < fns.length; i += 1) {
      const fn = fns[i];
      const arg = args[i] as unknown[];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform && Array.isArray(arg)) ctm = Util.transform(ctm, arg as number[]) as Matrix;
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        const matrix = Array.isArray(arg) && Array.isArray(arg[0]) ? arg[0] as number[] : null;
        if (matrix && matrix.length === 6) ctm = Util.transform(ctm, matrix) as Matrix;
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.constructPath && Array.isArray(arg)) {
        const subOps = arg[0] as number[];
        const coords = arg[1] as number[];
        let j = 0;
        let cx = 0; let cy = 0; let sx = 0; let sy = 0;
        for (const op of subOps) {
          if (op === OPS.moveTo) { cx = coords[j]; cy = coords[j + 1]; sx = cx; sy = cy; j += 2; }
          else if (op === OPS.lineTo) { push(cx, cy, coords[j], coords[j + 1]); cx = coords[j]; cy = coords[j + 1]; j += 2; }
          else if (op === OPS.curveTo) { push(cx, cy, coords[j + 4], coords[j + 5]); cx = coords[j + 4]; cy = coords[j + 5]; j += 6; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { push(cx, cy, coords[j + 2], coords[j + 3]); cx = coords[j + 2]; cy = coords[j + 3]; j += 4; }
          else if (op === OPS.rectangle) {
            const [x, y, w, h] = [coords[j], coords[j + 1], coords[j + 2], coords[j + 3]];
            push(x, y, x + w, y); push(x + w, y, x + w, y + h); push(x + w, y + h, x, y + h); push(x, y + h, x, y);
            cx = x; cy = y; sx = x; sy = y; j += 4;
          } else if (op === OPS.closePath) { push(cx, cy, sx, sy); cx = sx; cy = sy; }
        }
      }
    }
  } catch {
    /* vector data is optional */
  }
  return out;
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* -------------------------------------------------------------- zoning */

type Line = {
  text: string;
  x: number; y: number; width: number; height: number;
  fh: number;
  index: number;
};

type Rect = { x: number; y: number; width: number; height: number };

const VIEW_WORDS = /\b(PLANS?|DETAILS?|SECTIONS?|ELEVATIONS?|DIAGRAM|RISER|ONE[-\s]?LINE|SINGLE[-\s]LINE|PHOTOMETRICS?|ENLARGED)\b/i;
const SCALE_RE = /\bSCALE\b|\d+\s*\/\s*\d+\s*"\s*=|\d+\s*"\s*=\s*\d|1\s*"\s*=\s*\d+\s*'|\bN\.?\s?T\.?\s?S\.?\b|NOT\s+TO\s+SCALE/i;
const SENTENCE_WORDS = /\b(SEE|REFER|PER|PROVIDE|SHALL|INSTALL|CONTRACTOR|WHERE|WITH|ALL|THE|AND|FOR|TO\s+BE|SHOWN)\b/i;
const SHEET_NO_RE = /^[A-Z]{1,3}[-.]?\d{1,3}(?:\.\d{1,2})?[A-Z]?$/;

const HEADER_KINDS: Array<{ kind: PageZoneKind; pattern: RegExp }> = [
  { kind: 'schedule', pattern: /\bSCHEDULES?\b/i },
  { kind: 'legend', pattern: /\b(LEGEND|SYMBOLS?(\s+LIST)?|ABBREVIATIONS)\b/i },
  { kind: 'key_plan', pattern: /\bKEY\s*PLAN\b/i },
  { kind: 'notes', pattern: /\bNOTES?\b/i },
];

export function zoneFromSignals(input: ZonePageInput): PageZone[] {
  const W = Math.max(1, input.pageWidth);
  const H = Math.max(1, input.pageHeight);
  const toPct = (r: Rect): DocRect => ({
    x: clampPct((r.x / W) * 100),
    y: clampPct((r.y / H) * 100),
    width: clampPct((r.width / W) * 100),
    height: clampPct((r.height / H) * 100),
  });
  const sheet: PageZone = {
    id: 'sheet', kind: 'plan', bounds: { x: 0, y: 0, width: 100, height: 100 }, label: 'Sheet', confidence: 0.5, source: 'sheet',
  };

  if (input.visionZones?.length && isSparseText(input.textItems)) {
    return [sheet, ...input.visionZones];
  }

  const segments = collectSegments(input);
  const lines = groupLines(input.textItems.filter(item => !item.vertical));
  const fhs = lines.map(line => line.fh).sort((a, b) => a - b);
  const pctl = (p: number) => (fhs.length ? fhs[Math.min(fhs.length - 1, Math.floor(fhs.length * p))] : 10);
  const titleFh = pctl(0.6);
  const hLines = horizontalSegments(segments, W);

  const isTitle = (line: Line) => isTitleForm(line, titleFh, hLines);
  const zones: Array<PageZone & { rect: Rect }> = [];
  const add = (kind: PageZoneKind, rect: Rect, label: string, confidence: number, source: PageZoneSource) => {
    zones.push({ id: `z${zones.length + 1}`, kind, bounds: toPct(rect), label: label.slice(0, 80), confidence, source, rect });
  };

  // 1. Title block (right strip or bottom strip).
  const titleBlock = detectTitleBlock(lines, segments, W, H);
  if (titleBlock) add('title_block', titleBlock.rect, 'Title block', titleBlock.confidence, titleBlock.source);
  const inTitleBlock = (r: Rect) => !!titleBlock && centerIn(r, titleBlock.rect);

  // 2. View titles (title + scale line) — handled after text zones.
  const viewTitles: Array<{ line: Line; kind: PageZoneKind }> = [];
  const tables = detectTableStacks(hLines, W, H);
  const claimedTables = new Set<number>();

  // 3. Header-driven text zones.
  for (const line of lines) {
    if (inTitleBlock(line)) continue;
    if (!isTitle(line)) continue;
    const viewKind = viewKindForTitle(line, lines);
    if (viewKind) {
      viewTitles.push({ line, kind: viewKind });
      continue;
    }
    const header = HEADER_KINDS.find(row => row.pattern.test(line.text));
    if (!header) continue;
    const tableIndex = tables.findIndex((table, index) => !claimedTables.has(index)
      && table.y >= line.y - 3 * line.fh && table.y <= line.y + line.height + 4 * line.fh
      && overlaps1d(table.x, table.x + table.width, line.x - line.fh, line.x + line.width + line.fh));
    if (tableIndex >= 0) {
      claimedTables.add(tableIndex);
      add(header.kind, union([line, tables[tableIndex]]), line.text, 0.9, 'vector');
      continue;
    }
    const block = growTextBlock(line, lines, W, H);
    add(header.kind, block, line.text, 0.78, 'text');
  }

  // 4. Headerless ruled tables with text inside → schedule.
  tables.forEach((table, index) => {
    if (claimedTables.has(index) || inTitleBlock(table)) return;
    if (zones.some(zone => centerIn(table, zone.rect))) return;
    const inside = lines.filter(line => centerIn(line, table));
    if (inside.length < 6) return;
    add('schedule', table, 'Schedule (table)', 0.7, 'vector');
  });

  // 5. Headerless dense paragraphs → notes.
  for (const block of detectSentenceBlocks(lines, W, H)) {
    if (inTitleBlock(block)) continue;
    if (zones.some(zone => overlapRatio(block, zone.rect) > 0.5)) continue;
    add('notes', block, 'Notes', 0.65, 'text');
  }

  // 6. Unruled text tables (≥4 rows sharing ≥3 column positions).
  for (const table of detectTextTables(lines)) {
    if (inTitleBlock(table) || zones.some(zone => overlapRatio(table, zone.rect) > 0.5)) continue;
    add('schedule', table, 'Schedule', 0.65, 'text');
  }

  // 7. Drawing views from view titles + connected drawing content.
  const textZoneRects = zones.map(zone => zone.rect);
  const views = assignViews(viewTitles, segments, input.textItems, textZoneRects, W, H);
  for (const view of views) add(view.kind, view.rect, view.label, 0.8, 'view');

  // Headerless "tables" inside a drawing view are drawing geometry (stairs, ceiling grids).
  const viewRects = views.filter(view => view.kind === 'plan' || view.kind === 'demo_plan').map(view => view.rect);
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    const zone = zones[i];
    if (zone.label !== 'Schedule (table)' && zone.label !== 'Schedule' && zone.label !== 'Notes') continue;
    if (viewRects.some(rect => overlapRatio(zone.rect, rect) > 0.9)) zones.splice(i, 1);
  }

  return [sheet, ...zones.map(({ rect: _rect, ...zone }) => zone)];
}

export async function ensurePageZones(docId: string, page: number): Promise<PageZone[]> {
  const { useCanvasStore } = await import('@/store/canvasStore');
  const canvas = useCanvasStore.getState();
  const pdfData = canvas.pdfDocuments[docId];
  const cached = getCachedPageZones(docId, page, pdfData?.contentRevision ?? 0);
  if (cached?.length) return cached;
  if (!pdfData?.pdfDocument || typeof pdfData.pdfDocument.getPage !== 'function') return [];
  try {
    return await zonePage(pdfData.pdfDocument, page, {
      docId,
      contentRevision: pdfData.contentRevision ?? 0,
    });
  } catch {
    return [];
  }
}

export async function zonePage(
  pdfDoc: PDFDocumentProxy,
  page: number,
  options?: {
    docId?: string;
    contentRevision?: number;
    visionFallback?: (args: { pageWidth: number; pageHeight: number }) => Promise<PageZone[]>;
  },
): Promise<PageZone[]> {
  const docId = options?.docId || 'active';
  const revision = options?.contentRevision ?? 0;
  const cached = getCachedPageZones(docId, page, revision);
  if (cached?.length) return cached;

  const pdfPage = await pdfDoc.getPage(page);
  const input = await extractZoneInputs(pdfPage);
  if (isSparseText(input.textItems) && options?.visionFallback) {
    input.visionZones = await options.visionFallback({ pageWidth: input.pageWidth, pageHeight: input.pageHeight });
  }
  const zones = zoneFromSignals(input);
  setCachedPageZones(docId, page, zones, revision);
  return zones;
}

/* ------------------------------------------------------------- filters */

export type ExcludedByZone = { zoneLabel: string; kind: PageZoneKind; count: number; itemIds: string[] };

/**
 * Keep detections whose display-percent location falls in a counted zone.
 * Locations MUST be display percent (vision `location`).
 */
export function filterDetectionsByZones<T extends { id: string; location?: { x: number; y: number } }>(
  items: T[],
  zones: PageZone[],
  options?: {
    include?: PageZoneKind[];
    /** Map a detection location to display percent of the full page (e.g. undo a crop). */
    toPagePct?: (loc: { x: number; y: number }) => { x: number; y: number };
  },
): { kept: T[]; excludedByZone: ExcludedByZone[]; warning?: string; lowConfidence?: boolean } {
  const include = new Set(options?.include?.length ? [...COUNTED_KINDS, ...options.include] : COUNTED_KINDS);
  const excluded = new Map<string, ExcludedByZone>();
  const kept: T[] = [];
  const warnings: string[] = [];

  for (const item of items) {
    const raw = item.location;
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
      kept.push(item);
      continue;
    }
    const loc = options?.toPagePct ? options.toPagePct(raw) : raw;
    const zone = zoneAtPoint(zones, loc.x, loc.y);
    if (!zone || include.has(zone.kind)) {
      kept.push(item);
      continue;
    }
    const key = `${zone.kind}:${zone.label}`;
    const row = excluded.get(key) || { zoneLabel: zone.label, kind: zone.kind, count: 0, itemIds: [] };
    row.count += 1;
    row.itemIds.push(item.id);
    excluded.set(key, row);
  }

  if ([...excluded.values()].some(row => row.kind === 'enlarged_plan')) {
    warnings.push('Enlarged plan excluded — it may duplicate the main plan.');
  }

  // Safety rail: without an identified plan view, never silently drop most of a sheet.
  const hasPlanView = zones.some(zone => zone.kind === 'plan' && zone.source === 'view');
  const excludedCount = items.length - kept.length;
  if (!hasPlanView && items.length >= 5 && excludedCount / items.length > 0.6) {
    return {
      kept: items,
      excludedByZone: [],
      lowConfidence: true,
      warning: 'Zoning low confidence: no plan view identified, so nothing was excluded. Review the count.',
    };
  }

  return {
    kept,
    excludedByZone: [...excluded.values()],
    warning: warnings.length ? warnings.join(' ') : undefined,
  };
}

/** Tiles (display points) fully inside an excluded zone can be skipped. */
export function skipTilesCoveredByNonPlanZones<T extends DocRect>(
  tiles: T[],
  zones: PageZone[],
  pageSize?: { width: number; height: number },
): { kept: T[]; skipped: T[] } {
  const blockers = zones.filter(zone => !COUNTED_KINDS.includes(zone.kind));
  const kept: T[] = [];
  const skipped: T[] = [];
  for (const tile of tiles) {
    const pct = pageSize && pageSize.width > 0 && pageSize.height > 0
      ? {
        x: (tile.x / pageSize.width) * 100,
        y: (tile.y / pageSize.height) * 100,
        width: (tile.width / pageSize.width) * 100,
        height: (tile.height / pageSize.height) * 100,
      }
      : tile;
    // A tile is only skippable when no counted view overlaps it.
    const touchesPlan = zones.some(zone => zone.kind === 'plan' && zone.source === 'view' && rectsOverlap(pct, zone.bounds));
    if (!touchesPlan && blockers.some(zone => rectFullyInside(pct, zone.bounds))) skipped.push(tile);
    else kept.push(tile);
  }
  return { kept, skipped };
}

export function nonPlanCoverageRatio(zones: PageZone[]): number {
  const covered = zones
    .filter(zone => !COUNTED_KINDS.includes(zone.kind))
    .reduce((sum, zone) => sum + zone.bounds.width * zone.bounds.height, 0);
  return Math.min(1, covered / 10_000);
}

/** Zone at a display-percent point: text zones beat views, smaller beats larger, the sheet is last. */
export function zoneAtPoint(zones: PageZone[], x: number, y: number): PageZone | undefined {
  const hits = zones.filter(zone => pointInRect(x, y, zone.bounds));
  const rank = (zone: PageZone) => (zone.source === 'sheet' ? 2 : TEXT_ZONE_KINDS.has(zone.kind) ? 0 : 1);
  hits.sort((a, b) => rank(a) - rank(b) || a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height);
  return hits[0];
}

/* ------------------------------------------------------------- helpers */

function isSparseText(items: Array<{ str: string }>): boolean {
  const chars = items.reduce((sum, item) => sum + String(item.str || '').trim().length, 0);
  return items.length < 8 || chars < 80;
}

function collectSegments(input: ZonePageInput): number[] {
  const out: number[] = [];
  if (input.segments) for (let i = 0; i < input.segments.length; i += 1) out.push(input.segments[i]);
  for (const v of input.vectors || []) {
    if (v.kind === 'rect') {
      out.push(v.x, v.y, v.x + v.width, v.y, v.x + v.width, v.y, v.x + v.width, v.y + v.height,
        v.x + v.width, v.y + v.height, v.x, v.y + v.height, v.x, v.y + v.height, v.x, v.y);
    } else if (v.kind === 'hline') out.push(v.x, v.y, v.x + v.width, v.y);
    else out.push(v.x, v.y, v.x, v.y + v.height);
  }
  return out;
}

function groupLines(items: ZoneTextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2) || a.x - b.x);
  const lines: Line[] = [];
  const open: Line[] = [];
  for (const item of sorted) {
    const fh = item.fontHeight || item.height || 8;
    const cy = item.y + item.height / 2;
    let target: Line | undefined;
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const line = open[i];
      const lcy = line.y + line.height / 2;
      if (Math.abs(lcy - cy) > 0.45 * Math.max(fh, line.fh)) continue;
      if (Math.abs(fh - line.fh) > 0.35 * Math.max(fh, line.fh)) continue;
      const gap = item.x - (line.x + line.width);
      if (gap > 1.6 * Math.max(fh, line.fh) || item.x + item.width < line.x - fh) continue;
      target = line;
      break;
    }
    if (target) {
      const right = Math.max(target.x + target.width, item.x + item.width);
      const bottom = Math.max(target.y + target.height, item.y + item.height);
      target.text = item.x >= target.x ? `${target.text} ${item.str}` : `${item.str} ${target.text}`;
      target.text = target.text.replace(/\s+/g, ' ').trim();
      target.x = Math.min(target.x, item.x);
      target.y = Math.min(target.y, item.y);
      target.width = right - target.x;
      target.height = bottom - target.y;
    } else {
      const line: Line = { text: item.str.trim(), x: item.x, y: item.y, width: item.width, height: item.height, fh, index: lines.length };
      lines.push(line);
      open.push(line);
      // Lines more than a few rows above can no longer receive items.
      while (open.length > 200) open.shift();
    }
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  lines.forEach((line, index) => { line.index = index; });
  return lines;
}

function isTitleForm(line: Line, titleFh: number, hLines: HSeg[]): boolean {
  const text = line.text.replace(/[:.\s]+$/, '').trim();
  if (text.length < 4 || text.length > 70) return false;
  const words = text.split(/\s+/);
  if (words.length > 9) return false;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
  if (upper < 0.85) return false;
  if (/^\(?\d+[.)]\s/.test(text)) return false;
  if (SENTENCE_WORDS.test(text) && !/^(GENERAL|KEYED|SHEET|CODED|LIGHTING|POWER|ELECTRICAL|FIXTURE|LIGHT|PLAN)\b/i.test(text)) {
    return false;
  }
  if (line.fh >= titleFh * 1.05) return true;
  // Underlined title (a ruling just below the text, most of its width).
  return hLines.some(seg => seg.y >= line.y + line.height - 1 && seg.y <= line.y + line.height + 0.8 * line.fh
    && seg.x1 <= line.x + line.width * 0.2 && seg.x2 >= line.x + line.width * 0.8);
}

function viewKindForTitle(line: Line, lines: Line[]): PageZoneKind | null {
  const text = line.text;
  if (/\bSCHEDULE/i.test(text) || /\bNOTES?\b|\bLEGEND\b/i.test(text)) return null;
  if (!VIEW_WORDS.test(text)) return null;
  const hasScale = SCALE_RE.test(text) || lines.some(other => other !== line
    && SCALE_RE.test(other.text)
    && other.y >= line.y - 0.5 * line.fh
    && other.y <= line.y + line.height + 3 * line.fh
    && overlaps1d(other.x, other.x + other.width, line.x - 2 * line.fh, line.x + line.width + 6 * line.fh));
  if (!hasScale) return null;
  if (/\b(ONE[-\s]?LINE|SINGLE[-\s]LINE|RISER|DIAGRAM)\b/i.test(text)) return 'diagram';
  if (/\bDEMO(LITION)?\b|\bEXISTING\s+TO\s+BE\s+REMOVED\b/i.test(text)) return 'demo_plan';
  if (/\bPHOTOMETRIC/i.test(text)) return 'photometric';
  if (/\bENLARGED\b/i.test(text)) return 'enlarged_plan';
  if (/\bKEY\s*PLAN\b/i.test(text)) return 'key_plan';
  if (/\bPLANS?\b/i.test(text)) return 'plan';
  return 'detail';
}

/** Grow a text block under a header line by line; stop at the first paragraph break. */
function growTextBlock(header: Line, lines: Line[], W: number, H: number): Rect {
  let block: Rect = { x: header.x, y: header.y, width: header.width, height: header.height };
  let bodyFh = 0;
  const maxW = W * 0.45;
  for (let i = header.index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.y < block.y) continue;
    const fh = bodyFh || line.fh;
    const gap = line.y - (block.y + block.height);
    const maxGap = bodyFh ? Math.max(2.4 * fh, 1.6 * header.fh) : 3 * header.fh;
    if (gap > maxGap) {
      // Lines further down in the same column end the block; lines elsewhere are skipped.
      if (overlaps1d(line.x, line.x + line.width, block.x, block.x + block.width)) break;
      continue;
    }
    // Headers are often centred over their block: the first body line only has to sit under
    // the header; later lines must align with the block's left edge.
    const leftOk = bodyFh
      ? line.x >= block.x - 2.5 * fh && line.x <= block.x + Math.max(block.width, 12 * fh)
      : overlaps1d(line.x, line.x + line.width, header.x, header.x + header.width) && gap <= 3 * header.fh;
    if (!leftOk) continue;
    if (bodyFh && Math.abs(line.fh - bodyFh) > 0.45 * bodyFh) continue;
    const next = union([block, line]);
    if (next.width > maxW) continue;
    block = next;
    if (!bodyFh) bodyFh = line.fh;
    if (block.height > H * 0.6) break;
  }
  return block;
}

type HSeg = { x1: number; x2: number; y: number };

function horizontalSegments(seg: number[], W: number): HSeg[] {
  const out: HSeg[] = [];
  for (let i = 0; i + 3 < seg.length; i += 4) {
    const [x1, y1, x2, y2] = [seg[i], seg[i + 1], seg[i + 2], seg[i + 3]];
    if (Math.abs(y1 - y2) > 0.6) continue;
    const len = Math.abs(x2 - x1);
    if (len < W * 0.02) continue;
    out.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y: (y1 + y2) / 2 });
  }
  return out;
}

/** Stacks of ≥5 parallel horizontal rules with the same extent = ruled table. */
function detectTableStacks(h: HSeg[], W: number, H: number): Rect[] {
  const groups = new Map<string, HSeg[]>();
  for (const seg of h) {
    if (seg.x2 - seg.x1 > W * 0.6) continue;
    const key = `${Math.round(seg.x1 / 4)}:${Math.round(seg.x2 / 4)}`;
    const list = groups.get(key) || [];
    list.push(seg);
    groups.set(key, list);
  }
  const out: Rect[] = [];
  for (const list of groups.values()) {
    if (list.length < 5) continue;
    const ys = [...new Set(list.map(seg => Math.round(seg.y)))].sort((a, b) => a - b);
    let run: number[] = [ys[0]];
    const flush = () => {
      if (run.length >= 5) {
        const x1 = Math.min(...list.map(seg => seg.x1));
        const x2 = Math.max(...list.map(seg => seg.x2));
        out.push({ x: x1, y: run[0], width: x2 - x1, height: run[run.length - 1] - run[0] });
      }
    };
    for (let i = 1; i < ys.length; i += 1) {
      if (ys[i] - ys[i - 1] <= H * 0.05) run.push(ys[i]);
      else { flush(); run = [ys[i]]; }
    }
    flush();
  }
  // Merge stacks that overlap (multi-column schedules).
  const merged: Rect[] = [];
  for (const rect of out.sort((a, b) => b.width * b.height - a.width * a.height)) {
    const host = merged.find(m => overlapRatio(rect, m) > 0.3);
    if (host) Object.assign(host, union([host, rect]));
    else merged.push({ ...rect });
  }
  return merged.filter(rect => rect.height > H * 0.02);
}

function detectSentenceBlocks(lines: Line[], W: number, H: number): Rect[] {
  const isSentence = (line: Line) => line.text.length >= 28 && line.text.split(/\s+/).length >= 5;
  const used = new Set<number>();
  const out: Rect[] = [];
  for (const start of lines) {
    if (used.has(start.index) || !isSentence(start)) continue;
    let block: Rect = { x: start.x, y: start.y, width: start.width, height: start.height };
    let count = 1;
    let chars = start.text.length;
    used.add(start.index);
    for (let i = start.index + 1; i < lines.length; i += 1) {
      const line = lines[i];
      const gap = line.y - (block.y + block.height);
      if (gap > 2.6 * start.fh) {
        if (overlaps1d(line.x, line.x + line.width, block.x, block.x + block.width)) break;
        continue;
      }
      if (line.x < block.x - 3 * start.fh || line.x > block.x + block.width * 0.6) continue;
      if (Math.abs(line.fh - start.fh) > 0.45 * start.fh) continue;
      const next = union([block, line]);
      if (next.width > W * 0.45) continue;
      block = next;
      used.add(line.index);
      if (isSentence(line)) { count += 1; chars += line.text.length; }
    }
    if (count >= 5 && chars >= 250 && block.height < H * 0.7) out.push(block);
  }
  return out;
}

function detectTextTables(lines: Line[]): Rect[] {
  // Rows of short cells; a table = ≥4 consecutive rows sharing ≥3 column x-positions.
  const rows = new Map<number, Line[]>();
  for (const line of lines) {
    const key = Math.round(line.y / 3);
    const list = rows.get(key) || [];
    list.push(line);
    rows.set(key, list);
  }
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
  const out: Rect[] = [];
  let run: Line[][] = [];
  let cols: number[] = [];
  const colsOf = (row: Line[]) => row.map(line => line.x);
  const shared = (a: number[], b: number[]) => a.filter(x => b.some(y => Math.abs(x - y) <= 6)).length;
  const flush = () => {
    if (run.length >= 4) out.push(union(run.flat()));
    run = [];
    cols = [];
  };
  for (const row of ordered) {
    if (row.length < 3) { flush(); continue; }
    const rc = colsOf(row);
    if (!run.length) { run = [row]; cols = rc; continue; }
    const prev = run[run.length - 1];
    const gap = row[0].y - (prev[0].y + prev[0].height);
    if (shared(cols, rc) >= 3 && gap <= 3 * row[0].fh) {
      run.push(row);
      cols = cols.filter(x => rc.some(y => Math.abs(x - y) <= 6));
    } else {
      flush();
      run = [row];
      cols = rc;
    }
  }
  flush();
  return out;
}

function detectTitleBlock(
  lines: Line[],
  seg: number[],
  W: number,
  H: number,
): { rect: Rect; confidence: number; source: PageZoneSource } | null {
  const sheetNos = lines.filter(line => SHEET_NO_RE.test(line.text.trim()));
  const biggest = sheetNos.sort((a, b) => b.fh - a.fh)[0];
  // Long vertical rule in the right 30% spanning most of the sheet height.
  let bestX = Infinity;
  let bestY = Infinity;
  for (let i = 0; i + 3 < seg.length; i += 4) {
    const [x1, y1, x2, y2] = [seg[i], seg[i + 1], seg[i + 2], seg[i + 3]];
    if (Math.abs(x1 - x2) < 0.6 && Math.abs(y2 - y1) > H * 0.6 && x1 > W * 0.7 && x1 < W * 0.985) {
      if (!biggest || biggest.x >= x1 - 2) bestX = Math.min(bestX, x1);
    }
    if (Math.abs(y1 - y2) < 0.6 && Math.abs(x2 - x1) > W * 0.6 && y1 > H * 0.75 && y1 < H * 0.985) {
      if (!biggest || biggest.y >= y1 - 2) bestY = Math.min(bestY, y1);
    }
  }
  if (Number.isFinite(bestX) && (!biggest || biggest.x > W * 0.6)) {
    return { rect: { x: bestX, y: 0, width: W - bestX, height: H }, confidence: 0.9, source: 'vector' };
  }
  if (Number.isFinite(bestY)) {
    return { rect: { x: 0, y: bestY, width: W, height: H - bestY }, confidence: 0.85, source: 'vector' };
  }
  if (biggest && biggest.x > W * 0.8) {
    const x = Math.min(biggest.x - biggest.fh, W * 0.85);
    return { rect: { x, y: 0, width: W - x, height: H }, confidence: 0.6, source: 'text' };
  }
  if (biggest && biggest.y > H * 0.85) {
    const y = Math.min(biggest.y - biggest.fh, H * 0.88);
    return { rect: { x: 0, y, width: W, height: H - y }, confidence: 0.6, source: 'text' };
  }
  return null;
}

/* ---------------------------------------------------- view assignment */

function assignViews(
  titles: Array<{ line: Line; kind: PageZoneKind }>,
  seg: number[],
  textItems: ZoneTextItem[],
  blockedRects: Rect[],
  W: number,
  H: number,
): Array<{ kind: PageZoneKind; rect: Rect; label: string }> {
  if (!titles.length) return [];
  const cell = Math.max(W, H) / 220;
  const gw = Math.ceil(W / cell);
  const gh = Math.ceil(H / cell);
  const grid = new Uint8Array(gw * gh);
  const mark = (x: number, y: number) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) grid[cy * gw + cx] = 1;
  };
  for (let i = 0; i + 3 < seg.length; i += 4) {
    const [x1, y1, x2, y2] = [seg[i], seg[i + 1], seg[i + 2], seg[i + 3]];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (Math.abs(x2 - x1) > W * 0.4 || Math.abs(y2 - y1) > H * 0.4) continue; // borders / frames
    const steps = Math.max(1, Math.ceil(len / (cell * 0.5)));
    for (let s = 0; s <= steps; s += 1) mark(x1 + ((x2 - x1) * s) / steps, y1 + ((y2 - y1) * s) / steps);
  }
  for (const item of textItems) {
    for (let x = item.x; x <= item.x + item.width; x += cell * 0.5) {
      for (let y = item.y; y <= item.y + item.height; y += cell * 0.5) mark(x, y);
    }
  }
  // Text zones, title lines and their scale lines are not drawing content.
  const clear = (r: Rect) => {
    for (let cy = Math.max(0, Math.floor(r.y / cell)); cy <= Math.min(gh - 1, Math.floor((r.y + r.height) / cell)); cy += 1) {
      for (let cx = Math.max(0, Math.floor(r.x / cell)); cx <= Math.min(gw - 1, Math.floor((r.x + r.width) / cell)); cx += 1) grid[cy * gw + cx] = 0;
    }
  };
  blockedRects.forEach(clear);
  titles.forEach(t => clear({ x: t.line.x, y: t.line.y - 0.2 * t.line.fh, width: t.line.width, height: t.line.height + 2.6 * t.line.fh }));

  // Connected components (8-neighbour).
  const label = new Int32Array(gw * gh).fill(-1);
  const comps: Array<{ cells: number[]; x1: number; y1: number; x2: number; y2: number }> = [];
  const queue = new Int32Array(gw * gh);
  for (let start = 0; start < grid.length; start += 1) {
    if (!grid[start] || label[start] >= 0) continue;
    const id = comps.length;
    const comp = { cells: [] as number[], x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    let head = 0; let tail = 0;
    queue[tail++] = start; label[start] = id;
    while (head < tail) {
      const c = queue[head++];
      comp.cells.push(c);
      const cx = c % gw; const cy = (c - cx) / gw;
      comp.x1 = Math.min(comp.x1, cx); comp.x2 = Math.max(comp.x2, cx);
      comp.y1 = Math.min(comp.y1, cy); comp.y2 = Math.max(comp.y2, cy);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = cx + dx; const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (grid[n] && label[n] < 0) { label[n] = id; queue[tail++] = n; }
      }
    }
    comps.push(comp);
  }
  const big = comps.filter(comp => comp.cells.length >= 25);

  // Each title claims the components sitting directly above it (its view).
  const claims = new Map<number, number[]>(); // comp index -> title indexes
  titles.forEach((title, t) => {
    const tl = title.line;
    const tcx = (tl.x + tl.width / 2) / cell;
    const ty = tl.y / cell;
    let best = -1; let bestScore = Infinity;
    big.forEach((comp, i) => {
      const bottom = comp.y2;
      if (bottom < ty - (H * 0.2) / cell || comp.y1 > ty + 1) return; // must end just above the title
      const hx = tcx < comp.x1 ? comp.x1 - tcx : tcx > comp.x2 ? tcx - comp.x2 : 0;
      if (hx > (W * 0.08) / cell) return;
      const vy = Math.max(0, ty - bottom);
      const score = hx * 2 + vy - Math.log(comp.cells.length) * 4;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) claims.set(best, [...(claims.get(best) || []), t]);
  });

  const views: Array<{ kind: PageZoneKind; rect: Rect; label: string }> = [];
  for (const [ci, owners] of claims.entries()) {
    const comp = big[ci];
    const buckets = new Map<number, { x1: number; y1: number; x2: number; y2: number }>();
    for (const c of comp.cells) {
      const cx = c % gw; const cy = (c - cx) / gw;
      // Shared component: a cell belongs to the title whose view column it falls in.
      let owner = owners[0];
      if (owners.length > 1) {
        let bestD = Infinity;
        for (const t of owners) {
          const tl = titles[t].line;
          const mid = (tl.x + tl.width / 2) / cell;
          const d = Math.abs(cx - mid) + Math.max(0, cy - (tl.y + tl.height) / cell) * 3;
          if (d < bestD) { bestD = d; owner = t; }
        }
      }
      const b = buckets.get(owner) || { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
      b.x1 = Math.min(b.x1, cx); b.x2 = Math.max(b.x2, cx); b.y1 = Math.min(b.y1, cy); b.y2 = Math.max(b.y2, cy);
      buckets.set(owner, b);
    }
    for (const [t, b] of buckets.entries()) {
      const title = titles[t];
      let rect: Rect = { x: b.x1 * cell, y: b.y1 * cell, width: (b.x2 - b.x1 + 1) * cell, height: (b.y2 - b.y1 + 1) * cell };
      rect = union([rect, title.line]);
      // Excluded views (details/diagrams) are kept compact so they can't swallow a plan.
      if (title.kind !== 'plan' && title.kind !== 'demo_plan' && rect.width * rect.height > W * H * 0.3) continue;
      views.push({ kind: title.kind, rect, label: title.line.text });
    }
  }
  return views;
}

/* ----------------------------------------------------------- geometry */

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

function union(rects: Rect[]): Rect {
  const x1 = Math.min(...rects.map(r => r.x));
  const y1 = Math.min(...rects.map(r => r.y));
  const x2 = Math.max(...rects.map(r => r.x + r.width));
  const y2 = Math.max(...rects.map(r => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function overlaps1d(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 <= b2 && b1 <= a2;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return overlaps1d(a.x, a.x + a.width, b.x, b.x + b.width) && overlaps1d(a.y, a.y + a.height, b.y, b.y + b.height);
}

function overlapRatio(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-6, Math.min(a.width * a.height, b.width * b.height));
}

function centerIn(inner: Rect, outer: Rect): boolean {
  return pointInRect(inner.x + inner.width / 2, inner.y + inner.height / 2, outer);
}

function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height;
}

function rectFullyInside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width + 0.01
    && inner.y + inner.height <= outer.y + outer.height + 0.01;
}
