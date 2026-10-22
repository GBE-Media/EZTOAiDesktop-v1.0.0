import type { BlueprintAnalysisResult, DetectedItem } from '../providers/types';
import { NO_CONFIDENT_MATCH, normalizeMatchConfidence } from '../detection/visionLegendClassification';
import { detectionPctToDocPointerFields } from '../placement/parseChatMarkupPointer';

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
  analyzeByKey.set(key, { at: Date.now(), value: stored });
  if (options.scope === 'full' && options.promoteToLatestFull) {
    latestFullByDocPage.set(
      latestFullCacheKey(options.docId, options.page, options.contentRevision),
      {
        at: Date.now(),
        value: stored,
        docId: options.docId,
        contentRevision: options.contentRevision,
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
  return entry.value;
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

export interface PageItemCountResult {
  status: 'completed' | 'unavailable';
  page: number;
  query: string;
  source: 'cache' | 'fresh_analysis' | 'none';
  total: number;
  matchingTypeCounts: Record<string, number>;
  allTypeCounts: Record<string, number>;
  matchingItems: Array<{
    id: string;
    type: string;
    name: string;
    quantity: number;
    location?: { x: number; y: number };
    confidence?: number;
    legendTypeCode?: string;
    matchConfidence?: DetectedItem['matchConfidence'];
    unresolved?: boolean;
    code?: string;
  }>;
  unresolvedItems?: Array<{
    id: string;
    code?: string;
    reason: string;
    x?: number;
    y?: number;
  }>;
  truncated?: boolean;
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

function compactDocLocation(
  item: DetectedItem,
  pageWidth?: number,
  pageHeight?: number,
): { x: number; y: number } | undefined {
  const loc = item.location;
  if (!loc || !Number.isFinite(loc.x) || !Number.isFinite(loc.y)) return undefined;
  if (pageWidth && pageHeight && pageWidth > 0 && pageHeight > 0) {
    return detectionPctToDocPointerFields(loc, item.boundingBox, pageWidth, pageHeight).point;
  }
  return { x: loc.x, y: loc.y };
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

export function countItemsFromAnalysis(
  analysis: BlueprintAnalysisResult,
  query: string,
  options?: { source?: 'cache' | 'fresh_analysis'; pageWidth?: number; pageHeight?: number },
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

  const classified = matchingItems.map((item) => {
    const flag = itemIsUnresolvedForCounts(item);
    const loc = compactDocLocation(item, options?.pageWidth, options?.pageHeight);
    return { item, flag, loc };
  });
  const confirmed = classified.filter(row => !row.flag.unresolved);
  const unresolved = classified.filter(row => row.flag.unresolved);
  const MAX_ITEMS = 80;
  const truncated = confirmed.length + unresolved.length > MAX_ITEMS;

  return {
    status: 'completed',
    page: analysis.page,
    query: q,
    source: options?.source || 'cache',
    total: totalFromCounts > 0 ? totalFromCounts : confirmed.reduce(
      (sum, row) => sum + (typeof row.item.quantity === 'number' && row.item.quantity > 0 ? row.item.quantity : 1),
      0,
    ),
    matchingTypeCounts,
    allTypeCounts,
    matchingItems: confirmed.slice(0, MAX_ITEMS).map(({ item, loc }) => ({
      id: item.id,
      type: item.type,
      name: item.name,
      quantity: typeof item.quantity === 'number' ? item.quantity : 1,
      location: loc,
      confidence: item.confidence,
      legendTypeCode: item.legendTypeCode,
      matchConfidence: item.matchConfidence,
      unresolved: false,
      code: item.legendTypeCode || item.type,
    })),
    unresolvedItems: unresolved.slice(0, MAX_ITEMS).map(({ item, loc, flag }) => ({
      id: item.id,
      code: item.legendTypeCode || item.type,
      reason: flag.reason || 'unresolved',
      x: loc?.x,
      y: loc?.y,
    })),
    truncated: truncated || undefined,
    countReliability: reliability,
    legendTypeCodes: analysis.legendTypeCodes,
    verificationNotes,
    message: (q
      ? `Counted items matching "${q}" from page ${analysis.page} analysis (${options?.source || 'cache'}).`
      : `Returned all type counts for page ${analysis.page} (${options?.source || 'cache'}).`)
      + reliabilityNote
      + legendNote
      + (verificationNotes.length ? ` ${verificationNotes[0]}` : '')
      + (truncated ? ' Item list truncated to keep tool output compact.' : ''),
  };
}
