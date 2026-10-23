import type { BlueprintAnalysisResult, DetectedItem } from '../providers/types';
import { NO_CONFIDENT_MATCH, normalizeMatchConfidence } from '../detection/visionLegendClassification';
import type { PageGeometry } from '../placement/types';
import { pageGeometryFromUnrotated, visionLocationToDocPoint, type DisplayCrop } from '../placement/visionDisplayPctToDoc';
import type { PageAnalysisRef } from './pageAnalysisRef';
export type { PageAnalysisRef } from './pageAnalysisRef';

/** Compact analyze_page payload stored for reuse (no overview images). */
export interface CachedAnalyzePageResult {
  status: 'completed';
  page: number;
  scope: string;
  analysis: BlueprintAnalysisResult;
  textEvidence: {
    source: string;
    confidence: number;
    context: string;
    itemCount: number;
  };
  cached?: boolean;
  cacheNote?: string;
  analysisRef?: PageAnalysisRef;
}

export interface CachedExtractPageTextResult {
  status: 'completed';
  page: number;
  source: string;
  confidence: number;
  context: string;
  itemCount: number;
  items: unknown[];
  cached?: boolean;
  cacheNote?: string;
}

const CACHE_TTL_MS = 30 * 60 * 1000;

const analyzeByKey = new Map<string, { at: number; value: CachedAnalyzePageResult }>();
const extractByKey = new Map<string, { at: number; value: CachedExtractPageTextResult }>();
/** Latest broad (unprompted) full-page analysis per document+page+revision. */
const latestFullByDocPage = new Map<string, {
  at: number;
  value: CachedAnalyzePageResult;
  docId: string;
  contentRevision: number;
  analyzedAt: string;
  analysisId: string;
}>();

function stillFresh(at: number): boolean {
  return Date.now() - at < CACHE_TTL_MS;
}

export function buildAnalyzeCacheKey(options: {
  docId: string;
  page: number;
  scope: string;
  trade: string;
  contentRevision: number;
  prompt?: string;
  pageWidth: number;
  pageHeight: number;
  regionKey?: string;
}): string {
  const promptKey = (options.prompt || '').trim().slice(0, 120);
  const region = options.regionKey || '';
  return [
    options.docId,
    `rev${options.contentRevision}`,
    options.page,
    options.scope,
    options.trade,
    Math.round(options.pageWidth),
    Math.round(options.pageHeight),
    region,
    promptKey,
  ].join('|');
}

export function buildExtractCacheKey(options: {
  docId: string;
  page: number;
  contentRevision: number;
  pageWidth: number;
  pageHeight: number;
}): string {
  return [
    options.docId,
    `rev${options.contentRevision}`,
    'extract',
    options.page,
    Math.round(options.pageWidth),
    Math.round(options.pageHeight),
  ].join('|');
}

export function latestFullCacheKey(docId: string, page: number, contentRevision: number): string {
  return `${docId}|rev${contentRevision}|${page}`;
}

export function regionKeyFromRect(
  rect: { x: number; y: number; width: number; height: number } | undefined,
): string {
  if (!rect) return '';
  return [rect.x, rect.y, rect.width, rect.height].map(n => Math.round(n)).join(',');
}

export function getCachedAnalyze(key: string): CachedAnalyzePageResult | null {
  const entry = analyzeByKey.get(key);
  if (!entry || !stillFresh(entry.at)) {
    if (entry) analyzeByKey.delete(key);
    return null;
  }
  return {
    ...entry.value,
    analysis: entry.value.analysis,
    cached: true,
    cacheNote:
      'Returned cached analysis for this page/scope (already analyzed this session). '
      + 'Do NOT re-call analyze_page for the same page — use typeCounts/items or count_page_items.',
  };
}

export function setCachedAnalyze(
  key: string,
  value: CachedAnalyzePageResult,
  options: {
    docId: string;
    page: number;
    scope: string;
    contentRevision: number;
    /** Only broad/unprompted full-page analyses may become the canonical count source. */
    promoteToLatestFull?: boolean;
  },
): void {
  const stored: CachedAnalyzePageResult = {
    ...value,
    cached: undefined,
    cacheNote: undefined,
  };
  const analyzedAt = stored.analysisRef?.analyzedAt || new Date().toISOString();
  const analysisId = stored.analysisRef?.analysisId || crypto.randomUUID();
  const withRef: CachedAnalyzePageResult = {
    ...stored,
    analysisRef: {
      docId: options.docId,
      page: options.page,
      revision: options.contentRevision,
      analyzedAt,
      analysisId,
    },
  };
  analyzeByKey.set(key, { at: Date.now(), value: withRef });
  if (options.scope === 'full' && options.promoteToLatestFull) {
    latestFullByDocPage.set(
      latestFullCacheKey(options.docId, options.page, options.contentRevision),
      {
        at: Date.now(),
        value: withRef,
        docId: options.docId,
        contentRevision: options.contentRevision,
        analyzedAt,
        analysisId,
      },
    );
  }
}

export function getCachedExtract(key: string): CachedExtractPageTextResult | null {
  const entry = extractByKey.get(key);
  if (!entry || !stillFresh(entry.at)) {
    if (entry) extractByKey.delete(key);
    return null;
  }
  return {
    ...entry.value,
    cached: true,
    cacheNote:
      'Returned cached page text for this page (already extracted this session). '
      + 'Do NOT re-call extract_page_text for the same page unless the document changed.',
  };
}

export function setCachedExtract(key: string, value: CachedExtractPageTextResult): void {
  extractByKey.set(key, {
    at: Date.now(),
    value: {
      ...value,
      cached: undefined,
      cacheNote: undefined,
    },
  });
}

export function getLatestFullPageAnalysis(
  docId: string,
  page: number,
  contentRevision: number,
): CachedAnalyzePageResult | null {
  const entry = latestFullByDocPage.get(latestFullCacheKey(docId, page, contentRevision));
  if (!entry || !stillFresh(entry.at) || entry.contentRevision !== contentRevision) {
    if (entry) latestFullByDocPage.delete(latestFullCacheKey(docId, page, contentRevision));
    return null;
  }
  return {
    ...entry.value,
    analysisRef: {
      docId: entry.docId,
      page: entry.value.page,
      revision: entry.contentRevision,
      analyzedAt: entry.analyzedAt,
      analysisId: entry.analysisId,
    },
  };
}

/** Compact summary for agent context so follow-up turns know analysis already exists. */
export function summarizeCachedPageAnalyses(
  docId: string | null | undefined,
  contentRevision?: number | null,
): string | undefined {
  if (!docId) return undefined;
  if (contentRevision == null || !Number.isFinite(contentRevision)) return undefined;
  const lines: string[] = [];
  for (const [, entry] of latestFullByDocPage) {
    if (!stillFresh(entry.at) || entry.docId !== docId) continue;
    // Never present older-revision analyses as "already analyzed" for the current doc.
    if (entry.contentRevision !== contentRevision) continue;
    const page = entry.value.page;
    const counts = entry.value.analysis.typeCounts || {};
    const countParts = Object.entries(counts)
      .slice(0, 12)
      .map(([type, n]) => `${type}=${n}`);
    const itemCount = entry.value.analysis.items?.length ?? 0;
    lines.push(
      `page ${page}: ${itemCount} detections`
      + (countParts.length ? `; typeCounts: ${countParts.join(', ')}` : '')
      + ' (cached — prefer count_page_items / typeCounts; do not re-analyze unless page changed)',
    );
  }
  if (lines.length === 0) return undefined;
  return lines.sort().join('\n');
}

/** Test/debug helper: whether a canonical latestFull entry exists for doc+page+revision. */
export function hasLatestFullPageAnalysis(
  docId: string,
  page: number,
  contentRevision: number,
): boolean {
  return getLatestFullPageAnalysis(docId, page, contentRevision) != null;
}

export function clearPageAnalysisCache(docId?: string): void {
  if (!docId) {
    analyzeByKey.clear();
    extractByKey.clear();
    latestFullByDocPage.clear();
    return;
  }
  for (const key of [...analyzeByKey.keys()]) {
    if (key.startsWith(`${docId}|`)) analyzeByKey.delete(key);
  }
  for (const key of [...extractByKey.keys()]) {
    if (key.startsWith(`${docId}|`)) extractByKey.delete(key);
  }
  for (const key of [...latestFullByDocPage.keys()]) {
    const entry = latestFullByDocPage.get(key);
    if (entry?.docId === docId) latestFullByDocPage.delete(key);
  }
}

export const COUNT_ITEM_LIST_CHAR_BUDGET = 9_000;
/** Stay under sanitizeToolOutput's 50-item array slice so JSON stays parseable. */
export const COUNT_ITEM_ARRAY_MAX = 50;

export type CompactCountItemRow = {
  id: string;
  code: string;
  x: number;
  y: number;
  confidence?: number;
};

export type CompactUnresolvedItemRow = {
  id: string;
  code?: string;
  reason: string;
  x?: number;
  y?: number;
};

export interface PageItemCountResult {
  status: 'completed' | 'unavailable';
  page: number;
  query: string;
  source: 'cache' | 'fresh_analysis' | 'none';
  total: number;
  matchingTypeCounts: Record<string, number>;
  allTypeCounts: Record<string, number>;
  matchingItems: CompactCountItemRow[];
  unresolvedItems?: CompactUnresolvedItemRow[];
  truncated?: boolean;
  returnedItems?: number;
  omittedItems?: number;
  matchingReturned?: number;
  matchingOmitted?: number;
  unresolvedReturned?: number;
  unresolvedOmitted?: number;
  nextOffset?: number;
  hasMore?: boolean;
  nextUnresolvedOffset?: number;
  hasMoreUnresolved?: boolean;
  analysisRef?: PageAnalysisRef;
  countReliability?: 'high' | 'partial' | 'low';
  legendTypeCodes?: string[];
  verificationNotes?: string[];
  message?: string;
}

function itemMatchesQuery(item: DetectedItem, query: string): boolean {
  if (!query) return true;
  const hay = `${item.type || ''} ${item.name || ''}`.toLowerCase();
  const q = query.toLowerCase().trim();
  if (hay.includes(q)) return true;
  const tokens = q.split(/\s+/).filter(token => token.length >= 2);
  if (tokens.length === 0) return hay.includes(q);
  return tokens.every(token => hay.includes(token));
}

function typeKeyMatchesQuery(typeKey: string, query: string): boolean {
  if (!query) return true;
  const key = typeKey.toLowerCase();
  const q = query.toLowerCase().trim();
  if (key.includes(q) || q.includes(key)) return true;
  const tokens = q.split(/\s+/).filter(token => token.length >= 2);
  return tokens.some(token => key.includes(token));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function resolveCountPageGeometry(options?: {
  pageGeometry?: PageGeometry;
  pageWidth?: number;
  pageHeight?: number;
  page?: number;
}): PageGeometry | null {
  if (options?.pageGeometry && options.pageGeometry.docWidth > 0 && options.pageGeometry.docHeight > 0) {
    return options.pageGeometry;
  }
  if (options?.pageWidth && options?.pageHeight && options.pageWidth > 0 && options.pageHeight > 0) {
    return pageGeometryFromUnrotated({
      pageNumber: options.page || 1,
      docWidth: options.pageWidth,
      docHeight: options.pageHeight,
      rotationDeg: 0,
    });
  }
  return null;
}

function compactDocLocation(
  item: DetectedItem,
  page: PageGeometry | null,
  crop?: DisplayCrop,
): { x: number; y: number } | undefined {
  if (!page) {
    const loc = item.location;
    if (!loc || !Number.isFinite(loc.x) || !Number.isFinite(loc.y)) return undefined;
    return { x: round1(loc.x), y: round1(loc.y) };
  }
  const point = visionLocationToDocPoint(item.location, page, crop);
  if (!point) return undefined;
  return { x: round1(point.x), y: round1(point.y) };
}

function itemIsUnresolvedForCounts(item: DetectedItem): { unresolved: boolean; reason?: string } {
  const code = typeof item.legendTypeCode === 'string' ? item.legendTypeCode : '';
  if (code && code.trim() === NO_CONFIDENT_MATCH) {
    return { unresolved: true, reason: 'no_confident_match' };
  }
  if (normalizeMatchConfidence(item.matchConfidence) === 'low') {
    return { unresolved: true, reason: 'low confidence' };
  }
  return { unresolved: false };
}

function toCompactMatchingRow(item: DetectedItem, loc: { x: number; y: number }): CompactCountItemRow {
  const row: CompactCountItemRow = {
    id: item.id,
    code: (typeof item.legendTypeCode === 'string' && item.legendTypeCode.trim())
      ? item.legendTypeCode.trim()
      : item.type,
    x: loc.x,
    y: loc.y,
  };
  if (normalizeMatchConfidence(item.matchConfidence) !== 'high' && typeof item.confidence === 'number') {
    row.confidence = round1(item.confidence);
  }
  return row;
}

function packItemLists(options: {
  matching: CompactCountItemRow[];
  unresolved: CompactUnresolvedItemRow[];
  matchingOffset: number;
  unresolvedOffset: number;
  packMatching: boolean;
  packUnresolved: boolean;
  limit?: number;
}): {
  matchingItems: CompactCountItemRow[];
  unresolvedItems: CompactUnresolvedItemRow[];
  matchingReturned: number;
  matchingOmitted: number;
  unresolvedReturned: number;
  unresolvedOmitted: number;
} {
  const matchingOffset = Math.max(0, options.matchingOffset);
  const unresolvedOffset = Math.max(0, options.unresolvedOffset);
  const matchingWindow = options.packMatching ? options.matching.slice(matchingOffset) : [];
  const unresolvedWindow = options.packUnresolved ? options.unresolved.slice(unresolvedOffset) : [];
  const matchingCap = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit >= 0
    ? Math.min(COUNT_ITEM_ARRAY_MAX, options.limit)
    : COUNT_ITEM_ARRAY_MAX;
  const matchingItems: CompactCountItemRow[] = [];
  const unresolvedItems: CompactUnresolvedItemRow[] = [];
  let chars = 2;

  const fits = (row: unknown) => {
    const extra = JSON.stringify(row).length + 1;
    return chars + extra <= COUNT_ITEM_LIST_CHAR_BUDGET;
  };

  for (const row of matchingWindow) {
    if (matchingItems.length >= matchingCap) break;
    if (!fits(row)) break;
    matchingItems.push(row);
    chars += JSON.stringify(row).length + 1;
  }

  if (options.packUnresolved) {
    for (const row of unresolvedWindow) {
      if (unresolvedItems.length >= COUNT_ITEM_ARRAY_MAX) break;
      if (!fits(row)) break;
      unresolvedItems.push(row);
      chars += JSON.stringify(row).length + 1;
    }
  }

  return {
    matchingItems,
    unresolvedItems,
    matchingReturned: matchingItems.length,
    matchingOmitted: options.packMatching
      ? Math.max(0, options.matching.length - matchingOffset - matchingItems.length)
      : 0,
    unresolvedReturned: unresolvedItems.length,
    unresolvedOmitted: options.packUnresolved
      ? Math.max(0, options.unresolved.length - unresolvedOffset - unresolvedItems.length)
      : 0,
  };
}

export function countItemsFromAnalysis(
  analysis: BlueprintAnalysisResult,
  query: string,
  options?: {
    source?: 'cache' | 'fresh_analysis';
    pageWidth?: number;
    pageHeight?: number;
    pageGeometry?: PageGeometry;
    analysisRef?: PageAnalysisRef;
    offset?: number;
    limit?: number;
    code?: string;
    crop?: DisplayCrop;
    section?: 'matching' | 'unresolved';
  },
): PageItemCountResult {
  const q = query.trim();
  const items = analysis.items || [];
  const matchingItems = items.filter(item => itemMatchesQuery(item, q));
  // Prefer legend-grounded counts when present (includes zero-count legend types).
  const allTypeCounts = {
    ...(analysis.legendTypeCounts && Object.keys(analysis.legendTypeCounts).length > 0
      ? analysis.legendTypeCounts
      : analysis.typeCounts || {}),
  };
  const matchingTypeCounts: Record<string, number> = {};
  for (const [type, count] of Object.entries(allTypeCounts)) {
    if (typeKeyMatchesQuery(type, q)) {
      matchingTypeCounts[type] = count;
    }
  }

  const totalFromCounts = Object.values(matchingTypeCounts).reduce((sum, n) => sum + n, 0);
  const totalFromItems = matchingItems.reduce(
    (sum, item) => sum + (typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1),
    0,
  );

  const reliability = analysis.countReliability;
  const verificationNotes = analysis.countVerificationNotes || [];
  const reliabilityNote = reliability
    ? ` Count reliability: ${reliability}.`
    : '';
  const legendNote = analysis.legendTypeCodes?.length
    ? ` Legend-grounded types: ${analysis.legendTypeCodes.join(', ')}.`
    : ' No page legend types extracted — treat per-type counts as provisional.';

  const pageGeometry = resolveCountPageGeometry({
    pageGeometry: options?.pageGeometry,
    pageWidth: options?.pageWidth,
    pageHeight: options?.pageHeight,
    page: analysis.page,
  });
  const codeFilter = typeof options?.code === 'string' ? options.code.trim() : '';
  const classified = matchingItems.map((item) => {
    const flag = itemIsUnresolvedForCounts(item);
    const loc = compactDocLocation(item, pageGeometry, options?.crop);
    return { item, flag, loc };
  });
  const confirmed = classified.filter(row => !row.flag.unresolved);
  const unresolved = classified.filter(row => row.flag.unresolved);
  const matchingRows = confirmed
    .filter(({ item }) => {
      if (!codeFilter) return true;
      const code = (typeof item.legendTypeCode === 'string' && item.legendTypeCode.trim())
        ? item.legendTypeCode.trim()
        : item.type;
      return code.toLowerCase() === codeFilter.toLowerCase();
    })
    .filter((row): row is typeof row & { loc: { x: number; y: number } } => !!row.loc)
    .map(({ item, loc }) => toCompactMatchingRow(item, loc));
  const unresolvedRows: CompactUnresolvedItemRow[] = unresolved.map(({ item, loc, flag }) => ({
    id: item.id,
    code: item.legendTypeCode || item.type,
    reason: flag.reason || 'unresolved',
    x: loc?.x,
    y: loc?.y,
  }));

  const offset = typeof options?.offset === 'number' && Number.isFinite(options.offset)
    ? Math.max(0, Math.floor(options.offset))
    : 0;
  const section = options?.section === 'unresolved' ? 'unresolved' : 'matching';
  const packed = packItemLists({
    matching: matchingRows,
    unresolved: unresolvedRows,
    matchingOffset: section === 'matching' ? offset : 0,
    unresolvedOffset: section === 'unresolved' ? offset : 0,
    packMatching: section === 'matching',
    packUnresolved: section === 'unresolved' || (section === 'matching' && offset === 0),
    limit: options?.limit,
  });
  const omittedItems = packed.matchingOmitted + packed.unresolvedOmitted;
  const returnedItems = packed.matchingReturned + packed.unresolvedReturned;
  const truncated = omittedItems > 0;
  const matchingStart = section === 'matching' ? offset : 0;
  const unresolvedStart = section === 'unresolved' ? offset : 0;
  const hasMore = section === 'matching'
    && matchingStart + packed.matchingReturned < matchingRows.length;
  const nextOffset = hasMore ? matchingStart + packed.matchingReturned : undefined;
  const hasMoreUnresolved = packed.unresolvedReturned > 0 || section === 'unresolved' || offset === 0
    ? unresolvedStart + packed.unresolvedReturned < unresolvedRows.length
    : false;
  const nextUnresolvedOffset = hasMoreUnresolved
    ? unresolvedStart + packed.unresolvedReturned
    : undefined;

  return {
    status: 'completed',
    page: analysis.page,
    query: q,
    source: options?.source || 'cache',
    total: totalFromCounts > 0 ? totalFromCounts : totalFromItems,
    matchingTypeCounts,
    allTypeCounts,
    matchingItems: packed.matchingItems,
    unresolvedItems: packed.unresolvedItems,
    truncated: truncated || undefined,
    returnedItems,
    omittedItems,
    matchingReturned: packed.matchingReturned,
    matchingOmitted: packed.matchingOmitted,
    unresolvedReturned: packed.unresolvedReturned,
    unresolvedOmitted: packed.unresolvedOmitted,
    nextOffset: hasMore ? nextOffset : undefined,
    hasMore: hasMore || undefined,
    nextUnresolvedOffset,
    hasMoreUnresolved: hasMoreUnresolved || undefined,
    analysisRef: options?.analysisRef,
    countReliability: reliability,
    legendTypeCodes: analysis.legendTypeCodes,
    verificationNotes,
    message: (q
      ? `Counted items matching "${q}" from page ${analysis.page} analysis (${options?.source || 'cache'}).`
      : `Returned all type counts for page ${analysis.page} (${options?.source || 'cache'}).`)
      + reliabilityNote
      + legendNote
      + (verificationNotes.length ? ` ${verificationNotes[0]}` : '')
      + (truncated
        ? ` Returned ${returnedItems} item row(s); omitted ${omittedItems}.`
          + (hasMore
            ? ` Pass offset=${nextOffset ?? offset} (or code) to page through remaining matching items.`
            : '')
          + (hasMoreUnresolved
            ? ` Pass section=unresolved offset=${nextUnresolvedOffset ?? 0} to page through remaining unresolved items.`
            : '')
        : ''),
  };
}
