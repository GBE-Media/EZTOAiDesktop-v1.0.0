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

export const COUNT_ITEM_LIST_CHAR_BUDGET = 10_000;
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
  matchedCodes?: string[];
  unresolvedCountByType?: Record<string, number>;
  unresolvedTruncated?: boolean;
  countReliability?: 'high' | 'partial' | 'low';
  legendTypeCodes?: string[];
  verificationNotes?: string[];
  message?: string;
}

const QUERY_FILLER = new Set([
  'type', 'types', 'fixture', 'fixtures', 'light', 'lights', 'only',
  'units', 'unit', 'signs', 'sign', 'and', 'the', 'a', 'an', 'of', 'for',
]);

const QUERY_COMMON_ENGLISH = new Set([
  ...QUERY_FILLER,
  'how', 'many', 'are', 'is', 'on', 'in', 'at', 'to', 'from', 'with',
  'sheet', 'page', 'drawing', 'plan', 'this', 'that', 'what', 'which',
  'count', 'counted', 'please', 'list', 'there', 'here', 'all',
]);

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9/-]+/)
    .map(token => token.trim())
    .filter(Boolean);
}

type QueryToken = { raw: string; lower: string };

function tokenizeQueryRaw(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  const re = /[A-Za-z0-9/-]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query))) {
    tokens.push({ raw: match[0], lower: match[0].toLowerCase() });
  }
  return tokens;
}

function treatAsCodeA(
  token: QueryToken,
  index: number,
  tokens: QueryToken[],
  known: Map<string, string>,
): boolean {
  if (!known.has('a')) return false;
  if (token.lower !== 'a') return false;
  if (token.raw === 'A') return true;
  const prev = tokens[index - 1]?.lower;
  const next = tokens[index + 1]?.lower;
  if (prev === 'type' || prev === 'and' || next === 'and') return true;
  if (prev && known.has(prev) && prev !== 'a') return true;
  if (next && known.has(next) && next !== 'a') return true;
  return false;
}

function isQueryFiller(
  token: QueryToken,
  index: number,
  tokens: QueryToken[],
  known: Map<string, string>,
): boolean {
  if (treatAsCodeA(token, index, tokens, known)) return false;
  if (known.has(token.lower) && token.lower.length >= 3) return false;
  return QUERY_FILLER.has(token.lower);
}

/** Whole-token equality only — never substring (so "A" does not match "and"). */
export function typeKeyMatchesQuery(typeKey: string, query: string, knownCodes: string[] = []): boolean {
  if (!query.trim()) return true;
  const key = typeKey.toLowerCase();
  const known = new Map(knownCodes.map(code => [code.toLowerCase(), code]));
  const tokens = tokenizeQueryRaw(query);
  return tokens.some((token, index) => {
    if (isQueryFiller(token, index, tokens, known)) return false;
    return token.lower === key;
  });
}

/**
 * Legend codes named in the query: "Type A", "A-type", "type A fixtures", "EX1".
 * Filler words are ignored when collecting codes, except "A" when capitalized
 * or next to "type" / "and" / another legend code.
 */
export function parseMatchedLegendCodes(query: string, knownCodes: string[]): string[] {
  if (!query.trim() || knownCodes.length === 0) return [];
  const known = new Map(knownCodes.map(code => [code.toLowerCase(), code]));
  const matched = new Set<string>();
  const lower = query.toLowerCase();

  const typeForms = [
    ...lower.matchAll(/\btype\s+([a-z][a-z0-9/-]*)\b/g),
    ...lower.matchAll(/\b([a-z][a-z0-9/-]*)-type\b/g),
  ];
  for (const match of typeForms) {
    const canonical = known.get(match[1]);
    if (canonical) matched.add(canonical);
  }

  const tokens = tokenizeQueryRaw(query);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isQueryFiller(token, i, tokens, known)) continue;
    const canonical = known.get(token.lower);
    if (canonical) matched.add(canonical);
  }
  return [...matched];
}

function filteredDescriptionWords(query: string): string[] {
  return tokenizeQuery(query).filter(token => (
    token.length >= 3
    && !QUERY_COMMON_ENGLISH.has(token)
    && token.length > 1
  ));
}

function typeDescriptionMatchesQuery(
  typeKey: string,
  query: string,
  items: DetectedItem[],
): boolean {
  const words = filteredDescriptionWords(query);
  if (words.length === 0) return false;
  const hay = items
    .filter(item => (item.legendTypeCode || item.type || '').toLowerCase() === typeKey.toLowerCase())
    .map(item => `${item.type || ''} ${item.name || ''}`)
    .join(' ')
    .toLowerCase();
  if (!hay.trim()) return false;
  return words.some(word => hay.includes(word));
}

function itemMatchesQuery(item: DetectedItem, query: string, matchedCodes: string[]): boolean {
  if (!query) return true;
  if (matchedCodes.length > 0) {
    const code = (item.legendTypeCode || item.type || '').toLowerCase();
    return matchedCodes.some(m => m.toLowerCase() === code);
  }
  return false;
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

export type UnresolvedCountReason =
  | 'no location'
  | 'no_confident_match'
  | 'low confidence'
  | 'invalid legend code'
  | 'missing legend code';

export function itemIsUnresolvedForCounts(
  item: DetectedItem,
  legendTypeCodes?: string[] | null,
): { unresolved: boolean; reason?: UnresolvedCountReason } {
  if (item.locationMissing) {
    return { unresolved: true, reason: 'no location' };
  }
  const code = typeof item.legendTypeCode === 'string' ? item.legendTypeCode.trim() : '';
  if (code === NO_CONFIDENT_MATCH) {
    return { unresolved: true, reason: 'no_confident_match' };
  }
  if (normalizeMatchConfidence(item.matchConfidence) === 'low') {
    return { unresolved: true, reason: 'low confidence' };
  }
  if (!code) {
    return { unresolved: true, reason: 'missing legend code' };
  }
  if (legendTypeCodes && legendTypeCodes.length > 0) {
    const allowed = new Set(legendTypeCodes.map(c => c.trim().toLowerCase()));
    if (!allowed.has(code.toLowerCase())) {
      return { unresolved: true, reason: 'invalid legend code' };
    }
  }
  if (!Number.isFinite(item.location?.x) || !Number.isFinite(item.location?.y)) {
    return { unresolved: true, reason: 'no location' };
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
  // Prefer legend-grounded counts when present (includes zero-count legend types).
  const allTypeCounts = {
    ...(analysis.legendTypeCounts && Object.keys(analysis.legendTypeCounts).length > 0
      ? analysis.legendTypeCounts
      : analysis.typeCounts || {}),
  };
  const knownCodes = Object.keys(allTypeCounts);
  const matchedCodes = q ? parseMatchedLegendCodes(q, knownCodes) : [];
  const matchingTypeCounts: Record<string, number> = {};
  if (!q) {
    Object.assign(matchingTypeCounts, allTypeCounts);
  } else if (matchedCodes.length > 0) {
    for (const code of matchedCodes) {
      matchingTypeCounts[code] = allTypeCounts[code] ?? 0;
    }
  } else {
    for (const [type, count] of Object.entries(allTypeCounts)) {
      if (typeKeyMatchesQuery(type, q, knownCodes)) {
        matchingTypeCounts[type] = count;
      }
    }
    if (Object.keys(matchingTypeCounts).length === 0) {
      for (const [type, count] of Object.entries(allTypeCounts)) {
        if (typeDescriptionMatchesQuery(type, q, items)) {
          matchingTypeCounts[type] = count;
        }
      }
    }
  }

  const legendCodes = analysis.legendTypeCodes || knownCodes;
  const noParsedCodes = Boolean(q && matchedCodes.length === 0);
  const matchingItems = noParsedCodes
    ? []
    : items.filter(item => itemMatchesQuery(item, q, matchedCodes)
      && !itemIsUnresolvedForCounts(item, legendCodes).unresolved);
  const total = Object.values(matchingTypeCounts).reduce((sum, n) => sum + n, 0);

  const reliability = analysis.countReliability;
  const verificationNotes = [...(analysis.countVerificationNotes || [])];
  const namedNoCode = q && matchedCodes.length === 0 && Object.keys(matchingTypeCounts).length === 0;
  if (namedNoCode) {
    verificationNotes.unshift(`No known legend codes in query "${q}"; counted 0 (not a fuzzy match).`);
  }
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
  const classified = items.map((item) => {
    const flag = itemIsUnresolvedForCounts(item, legendCodes);
    const loc = item.locationMissing ? undefined : compactDocLocation(item, pageGeometry, options?.crop);
    return { item, flag, loc };
  });
  const confirmed = classified.filter(row => !row.flag.unresolved && matchingItems.includes(row.item));
  const unresolved = classified.filter(row => row.flag.unresolved);
  const unresolvedCountByType: Record<string, number> = {};
  for (const row of unresolved) {
    const code = row.item.legendTypeCode || row.item.type || 'unknown';
    unresolvedCountByType[code] = (unresolvedCountByType[code] || 0) + 1;
  }
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
  const limit = typeof options?.limit === 'number' && Number.isFinite(options.limit)
    ? Math.min(COUNT_ITEM_ARRAY_MAX, Math.max(0, Math.floor(options.limit)))
    : undefined;
  const section = options?.section === 'unresolved' ? 'unresolved' : 'matching';
  const matchingWindow = section === 'matching'
    ? matchingRows.slice(offset, limit != null ? offset + limit : undefined)
    : [];
  const unresolvedWindow = section === 'unresolved'
    ? unresolvedRows.slice(offset, limit != null ? offset + limit : undefined)
    : (section === 'matching' && offset === 0 ? unresolvedRows : []);
  let matchingPacked = matchingWindow;
  let unresolvedPacked = unresolvedWindow;
  const packResult = () => {
    const matchingOmitted = Math.max(0, matchingRows.length - (section === 'matching' ? offset : 0) - matchingPacked.length);
    const unresolvedOmitted = Math.max(0, unresolvedRows.length
      - (section === 'unresolved' ? offset : 0)
      - unresolvedPacked.length);
    const omittedItems = matchingOmitted + unresolvedOmitted;
    const returnedItems = matchingPacked.length + unresolvedPacked.length;
    const truncated = omittedItems > 0;
    const matchingStart = section === 'matching' ? offset : 0;
    const unresolvedStart = section === 'unresolved' ? offset : 0;
    const hasMore = section === 'matching'
      && matchingStart + matchingPacked.length < matchingRows.length;
    const nextOffset = hasMore ? matchingStart + matchingPacked.length : undefined;
    const hasMoreUnresolved = unresolvedStart + unresolvedPacked.length < unresolvedRows.length
      && (section === 'unresolved' || offset === 0);
    const nextUnresolvedOffset = hasMoreUnresolved
      ? unresolvedStart + unresolvedPacked.length
      : undefined;
    return {
      status: 'completed' as const,
      page: analysis.page,
      query: q,
      source: options?.source || 'cache',
      total,
      matchingTypeCounts,
      allTypeCounts,
      matchedCodes: matchedCodes.length ? matchedCodes : undefined,
      matchingItems: matchingPacked,
      unresolvedItems: unresolvedPacked,
      unresolvedCountByType,
      unresolvedTruncated: unresolvedOmitted > 0 || undefined,
      truncated: truncated || undefined,
      returnedItems,
      omittedItems,
      matchingReturned: matchingPacked.length,
      matchingOmitted,
      unresolvedReturned: unresolvedPacked.length,
      unresolvedOmitted,
      nextOffset: hasMore ? nextOffset : undefined,
      hasMore: hasMore || undefined,
      nextUnresolvedOffset,
      hasMoreUnresolved: hasMoreUnresolved || undefined,
      analysisRef: options?.analysisRef,
      countReliability: reliability,
      legendTypeCodes: analysis.legendTypeCodes,
      verificationNotes,
      message: (namedNoCode
        ? verificationNotes[0]
        : (q
          ? `Counted items matching "${q}" from page ${analysis.page} analysis (${options?.source || 'cache'}).`
          : `Returned all type counts for page ${analysis.page} (${options?.source || 'cache'}).`))
        + (namedNoCode ? '' : reliabilityNote)
        + (namedNoCode ? '' : legendNote)
        + (!namedNoCode && verificationNotes.length ? ` ${verificationNotes[0]}` : '')
        + (!namedNoCode && truncated
          ? ` Returned ${returnedItems} item row(s); omitted ${omittedItems}.`
            + (hasMore
              ? ` Pass offset=${nextOffset ?? offset} (or code) to page through remaining matching items.`
              : '')
            + (hasMoreUnresolved
              ? ` Pass section=unresolved offset=${nextUnresolvedOffset ?? 0} to page through remaining unresolved items.`
              : '')
          : ''),
    };
  };
  while (JSON.stringify(packResult()).length >= 10_000 && (matchingPacked.length + unresolvedPacked.length) > 0) {
    if (unresolvedPacked.length > 0) {
      unresolvedPacked = unresolvedPacked.length === 1
        ? []
        : unresolvedPacked.slice(0, Math.max(0, Math.floor(unresolvedPacked.length / 2)));
      continue;
    }
    if (matchingPacked.length > 0) {
      matchingPacked = matchingPacked.length === 1
        ? []
        : matchingPacked.slice(0, Math.max(0, Math.floor(matchingPacked.length / 2)));
      continue;
    }
    break;
  }
  return packResult();
}
