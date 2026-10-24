import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { getTextContentWithBounds, type TextItemWithBounds } from '@/lib/pdfLoader';
import { allIndexedPages, rememberIndexedPages } from '../projectIndex/store';
import type { IndexedPageRecord } from '../projectIndex/types';

export type PageZoneKind =
  | 'plan'
  | 'enlarged_plan'
  | 'schedule'
  | 'legend'
  | 'notes'
  | 'detail'
  | 'diagram'
  | 'title_block'
  | 'key_plan'
  | 'revisions';

export type PageZoneSource = 'text' | 'vector' | 'vision';

export type DocRect = { x: number; y: number; width: number; height: number };

export type PageZone = {
  id: string;
  kind: PageZoneKind;
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

export type ZonePageInput = {
  pageWidth: number;
  pageHeight: number;
  textItems: Array<Pick<TextItemWithBounds, 'str' | 'x' | 'y' | 'width' | 'height'>>;
  vectors?: ZoneVector[];
  visionZones?: PageZone[];
};

const HEADER_KIND: Array<{ kind: PageZoneKind; pattern: RegExp }> = [
  { kind: 'schedule', pattern: /\b(lighting\s+fixture\s+)?schedule\b|\bpanel\s+schedule\b/i },
  { kind: 'legend', pattern: /\b(legend|symbols|abbreviations)\b/i },
  { kind: 'notes', pattern: /\b(general\s+notes|keyed\s+notes|sheet\s+notes|coded\s+notes)\b/i },
  { kind: 'detail', pattern: /\bdetail\b|\b\d+\s*\/\s*[A-Z]-?\d+\b|\bsection\b|\belevation\b/i },
  { kind: 'diagram', pattern: /\b(riser|one[-\s]?line|single\s+line|diagram|lighting\s+control)\b/i },
  { kind: 'key_plan', pattern: /\bkey\s+plan\b/i },
  { kind: 'revisions', pattern: /\brevisions?\b/i },
  { kind: 'enlarged_plan', pattern: /\benlarged\b.+\bplan\b|\benlarged\s+plan\b/i },
  { kind: 'title_block', pattern: /\bsheet\s*(no\.?|number)\b|\btitle\s+block\b/i },
];

const DEFAULT_COUNT_KINDS: PageZoneKind[] = ['plan'];
const zoneMemory = new Map<string, PageZone[]>();

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

export function zoneFromSignals(input: ZonePageInput): PageZone[] {
  if (input.visionZones?.length && isSparseText(input.textItems)) {
    return finalizeZones(input.visionZones, input.pageWidth, input.pageHeight);
  }

  const lines = groupLines(input.textItems);
  const headers = detectHeaders(lines);
  const zones: PageZone[] = [];
  let n = 0;

  for (const header of headers) {
    const ruled = smallestEnclosingRect(header.bounds, input.vectors || []);
    const textBlock = clusterBelow(header, lines);
    const bounds = ruled || expand(unionRects([header.bounds, textBlock]), 8, input.pageWidth, input.pageHeight);
    n += 1;
    zones.push({
      id: `z${n}`,
      kind: header.kind,
      bounds,
      label: header.label,
      confidence: ruled ? 0.9 : 0.75,
      source: ruled ? 'vector' : 'text',
    });
  }

  const notes = detectDenseNotes(lines, zones, input.pageWidth, input.pageHeight);
  if (notes) {
    n += 1;
    zones.push({ ...notes, id: `z${n}` });
  }

  const unruled = detectUnruledSchedule(lines, zones, input.pageWidth, input.pageHeight);
  if (unruled) {
    n += 1;
    zones.push({ ...unruled, id: `z${n}` });
  }

  const title = detectTitleBlock(lines, input.vectors || [], input.pageWidth, input.pageHeight, zones);
  if (title) {
    n += 1;
    zones.push({ ...title, id: `z${n}` });
  }

  return finalizeZones(zones, input.pageWidth, input.pageHeight);
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
  const viewport = pdfPage.getViewport({ scale: 1 });
  const textItems = await getTextContentWithBounds(pdfDoc, page, 1);
  const vectors = await extractZoneVectors(pdfPage, viewport.width, viewport.height);
  let visionZones: PageZone[] | undefined;
  if (isSparseText(textItems) && options?.visionFallback) {
    visionZones = await options.visionFallback({
      pageWidth: viewport.width,
      pageHeight: viewport.height,
    });
  }
  const zones = zoneFromSignals({
    pageWidth: viewport.width,
    pageHeight: viewport.height,
    textItems,
    vectors,
    visionZones,
  });
  setCachedPageZones(docId, page, zones, revision);
  return zones;
}

export type ExcludedByZone = { zoneLabel: string; kind: PageZoneKind; count: number; itemIds: string[] };

export function filterDetectionsByZones<T extends { id: string; location?: { x: number; y: number } }>(
  items: T[],
  zones: PageZone[],
  options?: {
    pageWidth?: number;
    pageHeight?: number;
    include?: PageZoneKind[];
  },
): { kept: T[]; excludedByZone: ExcludedByZone[]; warning?: string } {
  const include = new Set(options?.include?.length ? options.include : DEFAULT_COUNT_KINDS);
  const pageWidth = options?.pageWidth || 0;
  const pageHeight = options?.pageHeight || 0;
  const excluded = new Map<string, ExcludedByZone>();
  const kept: T[] = [];
  let enlargedWarning = false;

  for (const item of items) {
    const center = itemCenter(item, pageWidth, pageHeight);
    const zone = zoneAtPoint(zones, center.x, center.y) || planZone(zones);
    if (!zone || include.has(zone.kind)) {
      kept.push(item);
      continue;
    }
    if (zone.kind === 'enlarged_plan') enlargedWarning = true;
    const key = `${zone.kind}:${zone.label}`;
    const row = excluded.get(key) || {
      zoneLabel: zone.label,
      kind: zone.kind,
      count: 0,
      itemIds: [],
    };
    row.count += 1;
    row.itemIds.push(item.id);
    excluded.set(key, row);
  }

  return {
    kept,
    excludedByZone: [...excluded.values()],
    warning: enlargedWarning ? 'may duplicate the main plan' : undefined,
  };
}

export function skipTilesCoveredByNonPlanZones<T extends DocRect>(
  tiles: T[],
  zones: PageZone[],
): { kept: T[]; skipped: T[] } {
  const blockers = zones.filter(zone => zone.kind !== 'plan');
  const kept: T[] = [];
  const skipped: T[] = [];
  for (const tile of tiles) {
    if (blockers.some(zone => rectFullyInside(tile, zone.bounds))) skipped.push(tile);
    else kept.push(tile);
  }
  return { kept, skipped };
}

export function nonPlanCoverageRatio(zones: PageZone[], pageWidth: number, pageHeight: number): number {
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const covered = zones
    .filter(zone => zone.kind !== 'plan')
    .reduce((sum, zone) => sum + zone.bounds.width * zone.bounds.height, 0);
  return Math.min(1, covered / pageArea);
}

function isSparseText(items: Array<{ str: string }>): boolean {
  const chars = items.reduce((sum, item) => sum + String(item.str || '').trim().length, 0);
  return items.length < 8 || chars < 80;
}

function groupLines(items: ZonePageInput['textItems']): Array<{
  text: string;
  bounds: DocRect;
  items: ZonePageInput['textItems'];
  fontHeight: number;
}> {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<{ text: string; bounds: DocRect; items: ZonePageInput['textItems']; fontHeight: number }> = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(item.y - last.bounds.y) <= Math.max(6, item.height * 0.6)
      && item.x <= last.bounds.x + last.bounds.width + 48) {
      last.items = [...last.items, item];
      last.text = `${last.text} ${item.str}`.replace(/\s+/g, ' ').trim();
      last.bounds = unionRects([last.bounds, rectOf(item)]);
      last.fontHeight = Math.max(last.fontHeight, item.height);
    } else {
      lines.push({
        text: item.str,
        bounds: rectOf(item),
        items: [item],
        fontHeight: item.height,
      });
    }
  }
  return lines;
}

function detectHeaders(lines: ReturnType<typeof groupLines>): Array<{
  kind: PageZoneKind;
  label: string;
  bounds: DocRect;
  lineIndex: number;
}> {
  const headers: Array<{ kind: PageZoneKind; label: string; bounds: DocRect; lineIndex: number }> = [];
  lines.forEach((line, lineIndex) => {
    for (const row of HEADER_KIND) {
      if (!row.pattern.test(line.text)) continue;
      headers.push({
        kind: row.kind,
        label: line.text.slice(0, 80),
        bounds: line.bounds,
        lineIndex,
      });
      break;
    }
  });
  return headers;
}

function clusterBelow(
  header: { bounds: DocRect; lineIndex: number; kind: PageZoneKind },
  lines: ReturnType<typeof groupLines>,
): DocRect {
  const below = lines.filter((line, index) => {
    if (index <= header.lineIndex) return false;
    if (line.bounds.y < header.bounds.y - 4) return false;
    if (line.bounds.y > header.bounds.y + 420) return false;
    const aligned = Math.abs(line.bounds.x - header.bounds.x) < 80
      || (line.bounds.x >= header.bounds.x - 24 && line.bounds.x <= header.bounds.x + Math.max(header.bounds.width, 280) + 24);
    return aligned;
  });
  if (!below.length) {
    return {
      x: header.bounds.x,
      y: header.bounds.y,
      width: Math.max(header.bounds.width, 220),
      height: 80,
    };
  }
  return unionRects([header.bounds, ...below.map(line => line.bounds)]);
}

function smallestEnclosingRect(header: DocRect, vectors: ZoneVector[]): DocRect | null {
  const rects = vectors.filter(row => row.kind === 'rect' && row.width > 40 && row.height > 40);
  const containing = rects.filter(rect => pointInRect(header.x + 2, header.y + 2, rect));
  if (!containing.length) return null;
  containing.sort((a, b) => a.width * a.height - b.width * b.height);
  const best = containing[0];
  return { x: best.x, y: best.y, width: best.width, height: best.height };
}

function detectDenseNotes(
  lines: ReturnType<typeof groupLines>,
  existing: PageZone[],
  pageWidth: number,
  pageHeight: number,
): PageZone | null {
  if (existing.some(zone => zone.kind === 'notes')) return null;
  const small = lines.filter(line => line.fontHeight <= 11 && line.items.length >= 1);
  const clusters: typeof small[] = [];
  for (const line of small) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(line.bounds.x - last[0].bounds.x) < 24 && line.bounds.y - (last[last.length - 1].bounds.y + last[last.length - 1].bounds.height) < 18) {
      last.push(line);
    } else {
      clusters.push([line]);
    }
  }
  const dense = clusters.find(cluster => cluster.length >= 6);
  if (!dense) return null;
  const bounds = expand(unionRects(dense.map(line => line.bounds)), 6, pageWidth, pageHeight);
  return {
    id: 'notes',
    kind: 'notes',
    bounds,
    label: 'GENERAL NOTES',
    confidence: 0.7,
    source: 'text',
  };
}

function detectUnruledSchedule(
  lines: ReturnType<typeof groupLines>,
  existing: PageZone[],
  pageWidth: number,
  pageHeight: number,
): PageZone | null {
  if (existing.some(zone => zone.kind === 'schedule')) return null;
  const typeRows = lines.filter(line => /^\s*TYPE\b/i.test(line.text) || /\bTYPE\s+[A-Z0-9]/i.test(line.text));
  const rows = lines.filter(line => /\btype\b/i.test(line.text) || /\s{2,}/.test(line.text));
  const columns = rows.filter(line => {
    const xs = line.items.map(item => item.x);
    const unique = new Set(xs.map(x => Math.round(x / 20)));
    return unique.size >= 3 || /\s{2,}/.test(line.text);
  });
  if (typeRows.length < 3 && columns.length < 3) return null;
  const used = typeRows.length >= 3 ? typeRows : columns;
  const bounds = expand(unionRects(used.map(line => line.bounds)), 10, pageWidth, pageHeight);
  return {
    id: 'schedule',
    kind: 'schedule',
    bounds,
    label: 'SCHEDULE',
    confidence: 0.72,
    source: 'text',
  };
}

function detectTitleBlock(
  lines: ReturnType<typeof groupLines>,
  vectors: ZoneVector[],
  pageWidth: number,
  pageHeight: number,
  existing: PageZone[],
): PageZone | null {
  if (existing.some(zone => zone.kind === 'title_block')) return null;
  const bottom = { x: 0, y: pageHeight * 0.86, width: pageWidth, height: pageHeight * 0.14 };
  const right = { x: pageWidth * 0.78, y: 0, width: pageWidth * 0.22, height: pageHeight };
  const strip = lines.some(line => /[A-Z]-\d{2,3}/.test(line.text) && pointInRect(line.bounds.x, line.bounds.y, bottom))
    ? bottom
    : lines.some(line => /[A-Z]-\d{2,3}/.test(line.text) && pointInRect(line.bounds.x, line.bounds.y, right))
      ? right
      : null;
  const bordered = vectors.find(row => row.kind === 'rect'
    && ((row.y > pageHeight * 0.8 && row.width > pageWidth * 0.4)
      || (row.x > pageWidth * 0.7 && row.height > pageHeight * 0.4)));
  const bounds = bordered
    ? { x: bordered.x, y: bordered.y, width: bordered.width, height: bordered.height }
    : strip;
  if (!bounds) return null;
  return {
    id: 'title',
    kind: 'title_block',
    bounds,
    label: 'Title block',
    confidence: bordered ? 0.88 : 0.65,
    source: bordered ? 'vector' : 'text',
  };
}

function finalizeZones(raw: PageZone[], pageWidth: number, pageHeight: number): PageZone[] {
  const nonPlan = mergeOverlapping(raw.filter(zone => zone.kind !== 'plan'));
  const remaining = largestRemaining(nonPlan, pageWidth, pageHeight);
  const plan: PageZone = {
    id: 'plan',
    kind: 'plan',
    bounds: remaining,
    label: 'Plan',
    confidence: 0.8,
    source: 'text',
  };
  return [plan, ...nonPlan];
}

function largestRemaining(blockers: PageZone[], pageWidth: number, pageHeight: number): DocRect {
  const full: DocRect = { x: 0, y: 0, width: pageWidth, height: pageHeight };
  if (!blockers.length) return full;
  const candidates: DocRect[] = [
    { x: 0, y: 0, width: pageWidth, height: Math.max(40, Math.min(...blockers.map(z => z.bounds.y))) },
    {
      x: 0,
      y: 0,
      width: Math.max(40, Math.min(...blockers.map(z => z.bounds.x))),
      height: pageHeight,
    },
  ];
  const rightEdge = Math.max(...blockers.map(z => z.bounds.x + z.bounds.width));
  if (rightEdge < pageWidth - 40) {
    candidates.push({ x: 0, y: 0, width: rightEdge < pageWidth * 0.7 ? rightEdge : pageWidth * 0.72, height: Math.min(...blockers.filter(z => z.bounds.y > pageHeight * 0.7).map(z => z.bounds.y).concat([pageHeight * 0.86])) });
  }
  candidates.push({
    x: 20,
    y: 20,
    width: Math.max(80, pageWidth - 40 - Math.max(0, ...blockers.filter(z => z.bounds.x > pageWidth * 0.55).map(z => z.bounds.width))),
    height: Math.max(80, pageHeight - 40 - Math.max(0, ...blockers.filter(z => z.bounds.y > pageHeight * 0.75).map(z => z.bounds.height))),
  });
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates[0] && candidates[0].width * candidates[0].height > pageWidth * pageHeight * 0.2
    ? candidates[0]
    : { x: 20, y: 20, width: pageWidth * 0.7, height: pageHeight * 0.78 };
}

function mergeOverlapping(zones: PageZone[]): PageZone[] {
  return zones;
}

async function extractZoneVectors(
  page: PDFPageProxy,
  pageWidth: number,
  pageHeight: number,
): Promise<ZoneVector[]> {
  try {
    const ops = await page.getOperatorList();
    const rects: ZoneVector[] = [];
    const fns = (ops as { fnArray?: number[]; argsArray?: unknown[] }).fnArray || [];
    const args = (ops as { fnArray?: number[]; argsArray?: unknown[] }).argsArray || [];
    for (let i = 0; i < fns.length; i += 1) {
      const fn = fns[i];
      const arg = args[i];
      if (fn === 20 && Array.isArray(arg) && arg.length >= 4) {
        const [x, y, w, h] = arg as number[];
        if (Math.abs(w) > 30 && Math.abs(h) > 30) {
          rects.push({
            kind: 'rect',
            x: Math.min(x, x + w),
            y: pageHeight - Math.max(y, y + h),
            width: Math.abs(w),
            height: Math.abs(h),
          });
        }
      }
      if ((fn === 4 || fn === 5) && Array.isArray(arg) && arg.length >= 4) {
        const [x1, y1, x2, y2] = arg as number[];
        const dx = Math.abs(x2 - x1);
        const dy = Math.abs(y2 - y1);
        if (dx > pageWidth * 0.2 && dy < 4) {
          rects.push({ kind: 'hline', x: Math.min(x1, x2), y: pageHeight - y1, width: dx, height: 1 });
        }
        if (dy > pageHeight * 0.2 && dx < 4) {
          rects.push({ kind: 'vline', x: x1, y: pageHeight - Math.max(y1, y2), width: 1, height: dy });
        }
      }
    }
    return rects.slice(0, 400);
  } catch {
    return [];
  }
}

function rectOf(item: { x: number; y: number; width: number; height: number }): DocRect {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

function unionRects(rects: DocRect[]): DocRect {
  const minX = Math.min(...rects.map(r => r.x));
  const minY = Math.min(...rects.map(r => r.y));
  const maxX = Math.max(...rects.map(r => r.x + r.width));
  const maxY = Math.max(...rects.map(r => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function expand(rect: DocRect, pad: number, pageWidth: number, pageHeight: number): DocRect {
  return {
    x: Math.max(0, rect.x - pad),
    y: Math.max(0, rect.y - pad),
    width: Math.min(pageWidth - Math.max(0, rect.x - pad), rect.width + pad * 2),
    height: Math.min(pageHeight - Math.max(0, rect.y - pad), rect.height + pad * 2),
  };
}

function pointInRect(x: number, y: number, rect: DocRect): boolean {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height;
}

function rectFullyInside(inner: DocRect, outer: DocRect): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width + 1
    && inner.y + inner.height <= outer.y + outer.height + 1;
}

function zoneAtPoint(zones: PageZone[], x: number, y: number): PageZone | undefined {
  const hits = zones.filter(zone => pointInRect(x, y, zone.bounds));
  hits.sort((a, b) => {
    const rank = (kind: PageZoneKind) => (kind === 'plan' ? 1 : 0);
    return rank(a.kind) - rank(b.kind) || a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height;
  });
  return hits[0];
}

function planZone(zones: PageZone[]): PageZone | undefined {
  return zones.find(zone => zone.kind === 'plan');
}

function itemCenter(
  item: { location?: { x: number; y: number } },
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number } {
  const x = item.location?.x ?? 0;
  const y = item.location?.y ?? 0;
  if (pageWidth > 0 && x <= 100 && y <= 100) {
    return { x: (x / 100) * pageWidth, y: (y / 100) * pageHeight };
  }
  return { x, y };
}
