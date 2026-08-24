import type { BlueprintAnalysisResult, DetectedItem } from '../providers/types';

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
    location?: DetectedItem['location'];
    confidence?: number;
  }>;
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

export function countItemsFromAnalysis(
  analysis: BlueprintAnalysisResult,
  query: string,
  options?: { source?: 'cache' | 'fresh_analysis' },
): PageItemCountResult {
  const q = query.trim();
  const items = analysis.items || [];
  const matchingItems = items.filter(item => itemMatchesQuery(item, q));
  const allTypeCounts = { ...(analysis.typeCounts || {}) };
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

  return {
    status: 'completed',
    page: analysis.page,
    query: q,
    source: options?.source || 'cache',
    total: totalFromCounts > 0 ? totalFromCounts : totalFromItems,
    matchingTypeCounts,
    allTypeCounts,
    matchingItems: matchingItems.slice(0, 50).map(item => ({
      id: item.id,
      type: item.type,
      name: item.name,
      quantity: typeof item.quantity === 'number' ? item.quantity : 1,
      location: item.location,
      confidence: item.confidence,
    })),
    message: q
      ? `Counted items matching "${q}" from page ${analysis.page} analysis (${options?.source || 'cache'}).`
      : `Returned all type counts for page ${analysis.page} (${options?.source || 'cache'}).`,
  };
}
