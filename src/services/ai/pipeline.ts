/**
 * AI Pipeline Coordinator
 * Manages the multi-stage AI processing pipeline
 */

import { getAIService } from './aiService';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  capturePageCrop,
  capturePageVisionBundle,
  type PageTileRegion,
} from './imageCapture';
import { skipTilesCoveredByNonPlanZones, type PageZone } from './detection/pageZones';
import { mergeLegendEntries, type SheetLegend } from './detection/sheetLegend';
import {
  getTextContentWithBounds,
  groupTextIntoLines,
  groupTextIntoColumnLines,
  renderPageForOcr,
  type TextItemWithBounds,
} from '@/lib/pdfLoader';
import { isScannedDocument, performOcr } from '@/lib/ocrEngine';
import { z } from 'zod';
import type {
  TradeType,
  BlueprintAnalysisResult,
  MaterialEstimate,
  CanvasPlacement,
  LayoutSuggestion,
  PipelineStage,
  ChatMarkupPointer,
} from './providers/types';
import {
  detectionPctToDocPointerFields,
  parseChatMarkupPointerRow,
} from './placement/parseChatMarkupPointer';
import {
  applyLegendAwareCounting,
  parseLegendFromPageItems,
  parseLegendFromTextLines,
} from './detection/legendAwareCounting';
import {
  buildLegendClassificationPrompt,
  normalizeMatchConfidence,
  resolveLegendAwareCounting,
} from './detection/visionLegendClassification';

export interface PipelineProgress {
  stage: PipelineStage | 'complete' | 'error';
  progress: number; // 0-100
  message: string;
  data?: unknown;
}

export type PipelineProgressCallback = (progress: PipelineProgress) => void;

export interface PipelineOptions {
  trade: TradeType;
  pages: number[]; // Page numbers to analyze
  imageGenerator?: (page: number) => Promise<string>; // Required unless resuming after vision
  pageWidth: number;
  pageHeight: number;
  userPrompt?: string;
  trainingContext?: string;
  location?: string;
  onProgress?: PipelineProgressCallback;
  pdfDoc?: PDFDocumentProxy;
  highAccuracyMode?: boolean;
  refinePlacements?: boolean;
  visibleOnly?: boolean;
  analysisRegion?: { x: number; y: number; width: number; height: number };
  getCachedText?: (page: number) => TextItemWithBounds[];
  setCachedText?: (page: number, items: TextItemWithBounds[]) => void;
  /** Continue after clarification with already-computed vision analysis. */
  resumeFrom?: {
    analysis: BlueprintAnalysisResult[];
    clarificationContext: string;
  };
}

const KEYWORDS = [
  'LIGHTING',
  'FIXTURE',
  'SCHEDULE',
  'TYPE',
  'LEGEND',
  'SYMBOL',
  'OUTLET',
  'RECEPTACLE',
  'EXIT',
  'EMERGENCY',
  'SWITCH',
  'SWITCHES',
];

const buildTextContext = (lines: string[]): string => {
  const upperLines = lines.map(line => line.toUpperCase());
  const matchedIndices = new Set<number>();

  upperLines.forEach((line, index) => {
    if (KEYWORDS.some(keyword => line.includes(keyword))) {
      matchedIndices.add(index);
      matchedIndices.add(index - 1);
      matchedIndices.add(index + 1);
      matchedIndices.add(index + 2);
    }
  });

  const selected = Array.from(matchedIndices)
    .filter(index => index >= 0 && index < lines.length)
    .sort((a, b) => a - b)
    .map(index => lines[index]);

  const fallback = lines.slice(0, 40);
  const combined = selected.length ? selected : fallback;

  const text = combined.join('\n');
  const maxChars = 6000;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
};

export interface PageTextEvidence {
  context: string;
  source: 'native' | 'ocr' | 'none';
  confidence?: number;
  items: TextItemWithBounds[];
}

export const extractPageTextEvidence = async (
  pdfDoc: PDFDocumentProxy,
  page: number,
  pageWidth: number,
  pageHeight: number,
  getCachedText?: (page: number) => TextItemWithBounds[],
  setCachedText?: (page: number, items: TextItemWithBounds[]) => void
): Promise<PageTextEvidence> => {
  try {
    const cachedItems = getCachedText?.(page) || [];
    const nativeItems = cachedItems.length > 0
      ? cachedItems
      : await getTextContentWithBounds(pdfDoc, page, 1.0);
    const scanned = isScannedDocument(nativeItems.length, pageWidth * pageHeight);

    if (!scanned) {
      if (cachedItems.length === 0) setCachedText?.(page, nativeItems);
      const lines = groupTextIntoLines(nativeItems, 5)
        .map(line => line.items.map(item => item.str).join(' ').trim())
        .filter(Boolean);
      return {
        context: buildTextContext(lines),
        source: 'native',
        confidence: 1,
        items: nativeItems,
      };
    }

    const canvas = await renderPageForOcr(pdfDoc, page, 300);
    const ocr = await performOcr(canvas);
    const scaleX = pageWidth / Math.max(1, canvas.width);
    const scaleY = pageHeight / Math.max(1, canvas.height);
    const ocrItems: TextItemWithBounds[] = ocr.words
      .filter(word => word.text.trim().length > 0)
      .map(word => ({
        str: word.text,
        x: word.x * scaleX,
        y: word.y * scaleY,
        width: word.width * scaleX,
        height: word.height * scaleY,
      }));
    setCachedText?.(page, ocrItems);
    const lines = ocr.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return {
      context: buildTextContext(lines),
      source: 'ocr',
      confidence: Math.max(0, Math.min(1, ocr.confidence / 100)),
      items: ocrItems,
    };
  } catch (error) {
    console.warn('[AI] Failed to extract page text/OCR evidence:', error);
    return { context: '', source: 'none', items: [] };
  }
};

const extractPageTextContext = async (
  pdfDoc: PDFDocumentProxy,
  page: number,
  pageWidth: number,
  pageHeight: number,
  getCachedText?: (page: number) => TextItemWithBounds[],
  setCachedText?: (page: number, items: TextItemWithBounds[]) => void
): Promise<string> => {
  try {
    const evidence = await extractPageTextEvidence(
      pdfDoc,
      page,
      pageWidth,
      pageHeight,
      getCachedText,
      setCachedText
    );
    const sourceLabel = evidence.source === 'ocr'
      ? `OCR text (confidence ${Math.round((evidence.confidence || 0) * 100)}%; verify uncertain characters)`
      : 'Native PDF text';
    return evidence.context ? `${sourceLabel}:\n${evidence.context}` : '';
  } catch (error) {
    console.warn('[AI] Failed to build page text context:', error);
    return '';
  }
};

const extractScheduleCrop = async (pdfDoc: PDFDocumentProxy, page: number, pageWidth: number, pageHeight: number) => {
  const textItems = await getTextContentWithBounds(pdfDoc, page, 1.0);
  const lines = groupTextIntoLines(textItems, 5);
  const scheduleLines = lines.filter(line =>
    line.items.some(item => item.str.toUpperCase().includes('FIXTURE')) ||
    line.items.some(item => item.str.toUpperCase().includes('SCHEDULE')) ||
    line.items.some(item => item.str.toUpperCase().includes('LEGEND'))
  );

  if (!scheduleLines.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  scheduleLines.forEach(line => {
    line.items.forEach(item => {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.width);
      maxY = Math.max(maxY, item.y + item.height);
    });
  });

  const padding = 40;
  const crop = {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    width: Math.min(pageWidth, maxX - minX + padding * 2),
    height: Math.min(pageHeight, maxY - minY + padding * 2),
  };

  return crop;
};

const generateTiles = (pageWidth: number, pageHeight: number, rows: number, cols: number) => {
  const tileWidth = pageWidth / cols;
  const tileHeight = pageHeight / rows;
  const tiles: Array<{ x: number; y: number; width: number; height: number }> = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      tiles.push({
        x: col * tileWidth,
        y: row * tileHeight,
        width: tileWidth,
        height: tileHeight,
      });
    }
  }

  return tiles;
};

const mergeTypeCounts = (entries: Array<Record<string, number> | undefined>) => {
  return entries.reduce((acc, entry) => {
    if (!entry) return acc;
    Object.entries(entry).forEach(([key, value]) => {
      acc[key] = (acc[key] || 0) + value;
    });
    return acc;
  }, {} as Record<string, number>);
};

const visionAnalysisSchema = z.object({
  items: z.array(z.record(z.unknown())).default([]),
  dimensions: z.array(z.record(z.unknown())).default([]),
  text: z.array(z.record(z.unknown())).default([]),
  symbols: z.array(z.record(z.unknown())).default([]),
  typeCounts: z.record(z.number()).optional(),
  questions: z.array(z.string()).optional(),
  questionOptions: z.array(z.record(z.unknown())).optional(),
  evidence: z.array(z.string()).optional(),
  projectInfo: z.record(z.unknown()).optional(),
});

function normalizePercent(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function usablePercent(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(0, Math.min(100, number));
}

function normalizeQuantity(value: unknown): number {
  const number = Number(value);
  if (Number.isFinite(number) && number > 1) return Math.min(50, Math.floor(number));
  return 1;
}

export function normalizeAnalysis(
  raw: unknown,
  page: number,
  trade: TradeType
): BlueprintAnalysisResult | null {
  const parsed = visionAnalysisSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;

  const items = data.items.map((candidate, index) => {
    const location = (candidate.location || {}) as Record<string, unknown>;
    const bounds = (candidate.boundingBox || {}) as Record<string, unknown>;
    const x = usablePercent(location.x);
    const y = usablePercent(location.y);
    const locationMissing = x === undefined || y === undefined;
    return {
      id: typeof candidate.id === 'string' ? candidate.id : `detected_${page}_${index}`,
      type: typeof candidate.type === 'string' ? candidate.type : 'unknown',
      trade,
      name: typeof candidate.name === 'string'
        ? candidate.name
        : (typeof candidate.type === 'string' ? candidate.type : 'Unknown item'),
      quantity: normalizeQuantity(candidate.quantity),
      locationMissing,
      location: {
        x: locationMissing ? Number.NaN : x,
        y: locationMissing ? Number.NaN : y,
        width: Number.isFinite(Number(location.width)) ? normalizePercent(location.width) : undefined,
        height: Number.isFinite(Number(location.height)) ? normalizePercent(location.height) : undefined,
      },
      boundingBox: Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y))
        ? {
            x: normalizePercent(bounds.x),
            y: normalizePercent(bounds.y),
            width: normalizePercent(bounds.width),
            height: normalizePercent(bounds.height),
          }
        : undefined,
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0.5)),
      evidence: typeof candidate.evidence === 'string' ? candidate.evidence : undefined,
      codeReference: typeof candidate.codeReference === 'string' ? candidate.codeReference : undefined,
      notes: typeof candidate.notes === 'string' ? candidate.notes : undefined,
      legendTypeCode: typeof candidate.legendTypeCode === 'string' ? candidate.legendTypeCode : undefined,
      // Single source of truth: same case-insensitive trim as downstream normalizer.
      matchConfidence: normalizeMatchConfidence(candidate.matchConfidence),
      matchReasoning: typeof candidate.matchReasoning === 'string'
        ? candidate.matchReasoning
        : undefined,
    };
  });

  return {
    page,
    items,
    dimensions: data.dimensions as unknown as BlueprintAnalysisResult['dimensions'],
    text: data.text as unknown as BlueprintAnalysisResult['text'],
    symbols: data.symbols as unknown as BlueprintAnalysisResult['symbols'],
    typeCounts: data.typeCounts,
    questions: data.questions,
    questionOptions: data.questionOptions as unknown as BlueprintAnalysisResult['questionOptions'],
    evidence: data.evidence,
    location: typeof data.projectInfo?.address === 'string'
      ? { address: data.projectInfo.address }
      : undefined,
  };
}

async function requestStructuredAnalysis(
  imageBase64: string,
  trade: TradeType,
  prompt: string,
  page: number
): Promise<BlueprintAnalysisResult> {
  const aiService = getAIService();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await aiService.analyzeBlueprint(
      imageBase64,
      trade,
      attempt === 0
        ? prompt
        : `${prompt}\n\nREPAIR: The previous response was malformed or incomplete. Return only one valid JSON object matching the requested schema.`
    );
    const parsed = parseJsonResponse(response.content);
    const normalized = normalizeAnalysis(parsed, page, trade);
    if (normalized) return normalized;
  }

  throw new Error(`Vision model returned invalid structured data for page ${page}`);
}

/** Absolute merge radius in page points (~0.25" at 72pt/in). */
export const TILE_MERGE_RADIUS_PT = 18;

export function mapTileItemToPage(
  item: BlueprintAnalysisResult['items'][number],
  region: PageTileRegion,
  pageWidth: number,
  pageHeight: number
): BlueprintAnalysisResult['items'] {
  const rawX = Number(item.location?.x);
  const rawY = Number(item.location?.y);
  const locationMissing = item.locationMissing === true || !Number.isFinite(rawX) || !Number.isFinite(rawY);
  const qty = Number(item.quantity);
  const copies = Number.isFinite(qty) && qty > 1 ? Math.min(50, Math.floor(qty)) : 1;
  const bounds = item.boundingBox;
  const localX = locationMissing ? 0 : normalizePercent(item.location.x);
  const localY = locationMissing ? 0 : normalizePercent(item.location.y);
  const pageX = region.x + (localX / 100) * region.width;
  const pageY = region.y + (localY / 100) * region.height;
  const baseId = `${region.id}_${item.id}`;

  return Array.from({ length: copies }, (_, k) => {
    const jitterX = copies > 1 ? k * 2 : 0;
    const jitterY = copies > 1 ? k * 2 : 0;
    return {
      ...item,
      id: copies > 1 ? `${baseId}#${k + 1}` : baseId,
      quantity: 1,
      locationMissing,
      sourceTileId: region.id,
      location: locationMissing
        ? { x: Number.NaN, y: Number.NaN }
        : {
          ...item.location,
          x: ((pageX + jitterX) / pageWidth) * 100,
          y: ((pageY + jitterY) / pageHeight) * 100,
          width: item.location.width === undefined
            ? undefined
            : (item.location.width / 100) * region.width / pageWidth * 100,
          height: item.location.height === undefined
            ? undefined
            : (item.location.height / 100) * region.height / pageHeight * 100,
        },
      boundingBox: locationMissing || !bounds
        ? undefined
        : {
          x: ((region.x + (bounds.x / 100) * region.width) / pageWidth) * 100,
          y: ((region.y + (bounds.y / 100) * region.height) / pageHeight) * 100,
          width: ((bounds.width / 100) * region.width / pageWidth) * 100,
          height: ((bounds.height / 100) * region.height / pageHeight) * 100,
        },
    };
  });
}

function regionOwnsPoint(
  region: PageTileRegion,
  pageX: number,
  pageY: number,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const x0 = region.ownership.x;
  const y0 = region.ownership.y;
  const x1 = region.ownership.x + region.ownership.width;
  const y1 = region.ownership.y + region.ownership.height;
  const xOk = pageX >= x0 && (x1 >= pageWidth - 1e-6 ? pageX <= pageWidth : pageX < x1);
  const yOk = pageY >= y0 && (y1 >= pageHeight - 1e-6 ? pageY <= pageHeight : pageY < y1);
  return xOk && yOk;
}

function isOwnedByTile(
  item: BlueprintAnalysisResult['items'][number],
  region: PageTileRegion,
  pageWidth: number,
  pageHeight: number
): boolean {
  const point = pagePoint(item, pageWidth, pageHeight);
  if (!point) return false;
  return regionOwnsPoint(region, point.x, point.y, pageWidth, pageHeight);
}

function normalizedType(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function detectionIdentity(item: BlueprintAnalysisResult['items'][number]): string {
  const code = typeof item.legendTypeCode === 'string' ? item.legendTypeCode.trim() : '';
  if (code) return code.toUpperCase();
  return normalizedType(item.type);
}

function sameLegendIdentity(
  left: BlueprintAnalysisResult['items'][number],
  right: BlueprintAnalysisResult['items'][number],
): boolean {
  const leftCode = typeof left.legendTypeCode === 'string' ? left.legendTypeCode.trim() : '';
  const rightCode = typeof right.legendTypeCode === 'string' ? right.legendTypeCode.trim() : '';
  if (leftCode || rightCode) return leftCode === rightCode;
  return detectionIdentity(left) === detectionIdentity(right);
}

function inOverlapBand(
  item: BlueprintAnalysisResult['items'][number],
  region: PageTileRegion,
  pageWidth: number,
  pageHeight: number,
): boolean {
  if (item.locationMissing) return false;
  const pageX = (item.location.x / 100) * pageWidth;
  const pageY = (item.location.y / 100) * pageHeight;
  const inCrop = pageX >= region.x && pageX <= region.x + region.width
    && pageY >= region.y && pageY <= region.y + region.height;
  return inCrop && !isOwnedByTile(item, region, pageWidth, pageHeight);
}

const OWNER_LINK_RADIUS_PT = 36;

function regionIndex(region: PageTileRegion): number {
  return region.row * 1000 + region.col;
}

function pagePoint(
  item: BlueprintAnalysisResult['items'][number],
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number } | null {
  if (item.locationMissing || !Number.isFinite(item.location?.x) || !Number.isFinite(item.location?.y)) {
    return null;
  }
  return {
    x: (item.location.x / 100) * pageWidth,
    y: (item.location.y / 100) * pageHeight,
  };
}

export function reconcileTileDetections(
  tileResults: Array<{ region: PageTileRegion; result: BlueprintAnalysisResult }>,
  pageWidth: number,
  pageHeight: number
): BlueprintAnalysisResult['items'] {
  const orderedTiles = [...tileResults].sort((a, b) => {
    const byRegion = regionIndex(a.region) - regionIndex(b.region);
    if (byRegion !== 0) return byRegion;
    return a.region.id.localeCompare(b.region.id);
  });
  const regionById = new Map(orderedTiles.map(row => [row.region.id, row.region]));
  const located: BlueprintAnalysisResult['items'] = [];
  const missing: BlueprintAnalysisResult['items'] = [];
  for (const { region, result } of orderedTiles) {
    const mappedItems = [...result.items].sort((a, b) => a.id.localeCompare(b.id));
    for (const item of mappedItems) {
      for (const mapped of mapTileItemToPage(item, region, pageWidth, pageHeight)) {
        if (mapped.locationMissing) missing.push(mapped);
        else located.push(mapped);
      }
    }
  }

  located.sort((a, b) => {
    const ra = a.sourceTileId ? regionById.get(a.sourceTileId) : undefined;
    const rb = b.sourceTileId ? regionById.get(b.sourceTileId) : undefined;
    const byRegion = regionIndex(ra || { row: 0, col: 0, id: '', x: 0, y: 0, width: 0, height: 0, ownership: { x: 0, y: 0, width: 0, height: 0 } })
      - regionIndex(rb || { row: 0, col: 0, id: '', x: 0, y: 0, width: 0, height: 0, ownership: { x: 0, y: 0, width: 0, height: 0 } });
    if (byRegion !== 0) return byRegion;
    return a.id.localeCompare(b.id);
  });

  const parent = located.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) parent[index] = find(parent[index]);
    return parent[index];
  };
  const union = (a: number, b: number) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent[pa] = pb;
  };

  for (let i = 0; i < located.length; i += 1) {
    const left = located[i];
    const leftPoint = pagePoint(left, pageWidth, pageHeight);
    if (!leftPoint) continue;
    let nearestIdx = -1;
    let nearestDist = Infinity;
    for (let j = 0; j < located.length; j += 1) {
      if (i === j) continue;
      const right = located[j];
      if (left.sourceTileId && right.sourceTileId && left.sourceTileId === right.sourceTileId) continue;
      if (!sameLegendIdentity(left, right)) continue;
      const rightPoint = pagePoint(right, pageWidth, pageHeight);
      if (!rightPoint) continue;
      const dist = Math.hypot(leftPoint.x - rightPoint.x, leftPoint.y - rightPoint.y);
      if (dist < OWNER_LINK_RADIUS_PT && dist < nearestDist) {
        nearestDist = dist;
        nearestIdx = j;
      }
    }
    if (nearestIdx >= 0) union(i, nearestIdx);
  }

  const regions = [...regionById.values()];
  const cellW = regions[0]?.ownership.width || pageWidth;
  const cellH = regions[0]?.ownership.height || pageHeight;
  const cols = Math.max(1, Math.round(pageWidth / Math.max(1, cellW)));
  const rows = Math.max(1, Math.round(pageHeight / Math.max(1, cellH)));
  const vertexRadius = 0.6 * 72;
  for (let row = 0; row <= rows; row += 1) {
    for (let col = 0; col <= cols; col += 1) {
      const vx = col * cellW;
      const vy = row * cellH;
      const nearVertex: number[] = [];
      located.forEach((item, index) => {
        const point = pagePoint(item, pageWidth, pageHeight);
        if (!point) return;
        if (Math.hypot(point.x - vx, point.y - vy) <= vertexRadius) nearVertex.push(index);
      });
      for (let i = 0; i < nearVertex.length; i += 1) {
        for (let j = i + 1; j < nearVertex.length; j += 1) {
          const left = located[nearVertex[i]];
          const right = located[nearVertex[j]];
          if (left.sourceTileId && right.sourceTileId && left.sourceTileId === right.sourceTileId) continue;
          if (!sameLegendIdentity(left, right)) continue;
          union(nearVertex[i], nearVertex[j]);
        }
      }
    }
  }

  const groups = new Map<number, typeof located>();
  located.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(item);
    groups.set(root, group);
  });

  const reconciled = [...groups.values()].map((group) => {
    const ranked = [...group].sort((a, b) => {
      const aRegion = a.sourceTileId ? regionById.get(a.sourceTileId) : undefined;
      const bRegion = b.sourceTileId ? regionById.get(b.sourceTileId) : undefined;
      const aOwned = aRegion ? isOwnedByTile(a, aRegion, pageWidth, pageHeight) : false;
      const bOwned = bRegion ? isOwnedByTile(b, bRegion, pageWidth, pageHeight) : false;
      if (aOwned !== bOwned) return aOwned ? -1 : 1;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.id.localeCompare(b.id);
    });
    return ranked[0];
  });

  missing.sort((a, b) => a.id.localeCompare(b.id));
  return [...reconciled, ...missing];
}

export interface MaximumAccuracyPageResult {
  analysis: BlueprintAnalysisResult;
  overviewImage: string;
  textEvidence: PageTextEvidence;
  skippedTiles?: number;
}

export async function analyzePageMaximumAccuracy(options: {
  pdfDoc: PDFDocumentProxy;
  page: number;
  pageWidth: number;
  pageHeight: number;
  trade: TradeType;
  userPrompt?: string;
  trainingContext?: string;
  visibleOnly?: boolean;
  analysisRegion?: { x: number; y: number; width: number; height: number };
  getCachedText?: (page: number) => TextItemWithBounds[];
  setCachedText?: (page: number, items: TextItemWithBounds[]) => void;
  onProgress?: (message: string, progress: number) => void;
  pageZones?: PageZone[];
  /** Legend from the set's legend/schedule sheet, used when this page has no legend of its own. */
  sheetLegend?: () => Promise<SheetLegend | null>;
}): Promise<MaximumAccuracyPageResult> {
  const {
    pdfDoc,
    page,
    pageWidth,
    pageHeight,
    trade,
    userPrompt,
    trainingContext,
    visibleOnly,
    analysisRegion,
    getCachedText,
    setCachedText,
    onProgress,
    pageZones,
    sheetLegend,
  } = options;

  onProgress?.(`Rendering high-resolution page ${page}...`, 5);
  const [bundle, textEvidence] = await Promise.all([
    capturePageVisionBundle(pdfDoc, page, pageWidth, pageHeight, { region: analysisRegion }),
    extractPageTextEvidence(pdfDoc, page, pageWidth, pageHeight, getCachedText, setCachedText),
  ]);
  let skippedTiles = 0;
  if (pageZones?.length && bundle.tiles.length) {
    const filtered = skipTilesCoveredByNonPlanZones(
      bundle.tiles.map(tile => tile.region),
      pageZones,
      { width: pageWidth, height: pageHeight },
    );
    skippedTiles = filtered.skipped.length;
    const keptIds = new Set(filtered.kept.map(region => `${region.x}:${region.y}:${region.width}:${region.height}`));
    bundle.tiles = bundle.tiles.filter(tile =>
      keptIds.has(`${tile.region.x}:${tile.region.y}:${tile.region.width}:${tile.region.height}`));
  }
  const textContext = visibleOnly || !textEvidence.context
    ? ''
    : `${textEvidence.source === 'ocr' ? 'OCR' : 'Native PDF'} text evidence:\n${textEvidence.context}`;

  // Legend-aware: parse the FULL page text (column-split), not the trimmed vision context.
  const legendSourceLines = textEvidence.items?.length
    ? groupTextIntoColumnLines(textEvidence.items)
    : (textEvidence.context
      ? textEvidence.context.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : []);
  const pageLegendEntries = visibleOnly
    ? []
    : (textEvidence.items?.length
      ? parseLegendFromPageItems(textEvidence.items)
      : parseLegendFromTextLines(legendSourceLines));
  let borrowedLegend: SheetLegend | null = null;
  if (!visibleOnly && sheetLegend) {
    borrowedLegend = await sheetLegend().catch(() => null);
  }
  const legendEntries = mergeLegendEntries(pageLegendEntries, borrowedLegend);
  if (borrowedLegend && legendEntries !== pageLegendEntries) {
    console.info('[legend] using legend sheet', { page, from: borrowedLegend.sourceLabel, count: legendEntries.length });
  } else {
    borrowedLegend = null;
  }
  if (legendEntries.length > 0) {
    console.info('[legend]', {
      page,
      region: textEvidence.items?.length ? 'column-split page text' : 'context lines',
      count: legendEntries.length,
      codes: legendEntries.map((entry) => entry.typeCode),
    });
  }
  const legendPrompt = buildLegendClassificationPrompt(legendEntries);

  const commonContext = [
    visibleOnly
      ? 'VISIBLE-ONLY MODE: Count only physical symbols visible in the drawing. Never use schedule rows as quantities.'
      : 'Use schedules and legends only to identify symbol types; never treat schedule rows as placed quantities.',
    legendPrompt || undefined,
    userPrompt ? `User request: ${userPrompt}` : undefined,
    trainingContext,
    textContext,
  ].filter(Boolean).join('\n\n');

  onProgress?.(`Analyzing page ${page} overview...`, 12);
  let overview = await requestStructuredAnalysis(
    bundle.overview.base64,
    trade,
    `${commonContext}\n\nOVERVIEW PASS: Understand the drawing, legend, and schedule relationships. Report detections for context, but do not infer counts from schedule rows.`,
    page
  );
  if (analysisRegion) {
    const overviewRegion: PageTileRegion = {
      id: 'overview-region',
      row: 0,
      col: 0,
      ...analysisRegion,
      ownership: analysisRegion,
    };
    overview = {
      ...overview,
      items: overview.items.flatMap(item => mapTileItemToPage(item, overviewRegion, pageWidth, pageHeight)),
    };
  }

  const tileResults: Array<{ region: PageTileRegion; result: BlueprintAnalysisResult }> = [];
  const failedTiles: string[] = [];
  const tileConcurrency = 3;
  const visionCallsBefore = 1 + bundle.tiles.length;
  console.info('[analyzePage] vision calls', {
    page,
    overview: 1,
    tiles: bundle.tiles.length,
    before: visionCallsBefore,
    afterConcurrentBatches: Math.ceil(bundle.tiles.length / tileConcurrency) + 1,
  });
  let completedTiles = 0;
  const runTile = async (tile: (typeof bundle.tiles)[number], index: number) => {
    onProgress?.(
      `Analyzing page ${page} detail tile ${index + 1}/${bundle.tiles.length}...`,
      15 + Math.round(((index + 1) / bundle.tiles.length) * 60)
    );
    try {
      const result = await requestStructuredAnalysis(
        tile.base64,
        trade,
        `${commonContext}\n\nDETAIL TILE ${tile.region.id}: Find every physical instance visible in this crop. ` +
        'Return one item per physical symbol with quantity 1, center location and boundingBox in 0-100 coordinates relative to this tile, confidence, and visual evidence. ' +
        (legendEntries.length
          ? 'For each item include legendTypeCode (from the allowed legend list or "no_confident_match"), matchConfidence ("high"|"medium"|"low"), and matchReasoning. '
          : '') +
        'Do not count schedule/legend rows as installed items.',
        page
      );
      tileResults.push({ region: tile.region, result });
    } catch (error) {
      failedTiles.push(tile.region.id);
      console.warn('[analyzePage] tile failed', tile.region.id, error);
    } finally {
      completedTiles += 1;
      void completedTiles;
    }
  };
  let nextTile = 0;
  const workers = Array.from(
    { length: Math.min(tileConcurrency, bundle.tiles.length) },
    async () => {
      while (nextTile < bundle.tiles.length) {
        const index = nextTile;
        nextTile += 1;
        await runTile(bundle.tiles[index], index);
      }
    },
  );
  await Promise.all(workers);

  onProgress?.(`Reconciling page ${page} detections...`, 80);
  tileResults.sort((a, b) => {
    const byRegion = (a.region.row * 1000 + a.region.col) - (b.region.row * 1000 + b.region.col);
    if (byRegion !== 0) return byRegion;
    return a.region.id.localeCompare(b.region.id);
  });
  const tileItems = reconcileTileDetections(tileResults, pageWidth, pageHeight);
  const rawItems = tileItems.length > 0 ? tileItems : overview.items;
  const locatedItems = rawItems.filter(item => !item.locationMissing);
  const missingLocationItems = rawItems.filter(item => !!item.locationMissing);

  // Primary: vision-native legendTypeCode fields. Secondary: token-overlap only when absent.
  const legendAware = resolveLegendAwareCounting({
    items: locatedItems,
    legendEntries,
    trade,
    applyTokenOverlapFallback: applyLegendAwareCounting,
  });
  const items = [...legendAware.items, ...missingLocationItems];
  const typeCounts = legendEntries.length > 0
    ? legendAware.legendTypeCounts
    : legendAware.typeCounts;
  const extraNotes: string[] = [];
  let countReliability = legendAware.reliability;
  if (missingLocationItems.length > 0) {
    extraNotes.push(`${missingLocationItems.length} detection(s) had no location and were counted as unresolved.`);
  }
  if (failedTiles.length > 0) {
    extraNotes.push(`Tile(s) failed: ${failedTiles.join(', ')}. Counts may be incomplete.`);
    countReliability = countReliability === 'high' ? 'partial' : 'low';
  }
  if (tileItems.length > 0 && overview.items.length > 0) {
    const byType = (list: typeof tileItems) => {
      const counts: Record<string, number> = {};
      for (const item of list) {
        if (item.locationMissing) continue;
        const key = (item.legendTypeCode || item.type || 'unknown').trim() || 'unknown';
        counts[key] = (counts[key] || 0) + 1;
      }
      return counts;
    };
    const tileByType = byType(tileItems);
    const overviewByType = byType(overview.items);
    const overflow: string[] = [];
    for (const [type, overviewCount] of Object.entries(overviewByType)) {
      const tileCount = tileByType[type] || 0;
      if (overviewCount > tileCount + 1 && overviewCount > tileCount * 1.2) {
        overflow.push(`${type}: overview ${overviewCount} > tiles ${tileCount}`);
      }
    }
    if (overflow.length > 0) {
      extraNotes.push(
        `Overview found more of a type than tiles (${overflow.join('; ')}); tiles may have missed symbols.`,
      );
      if (countReliability === 'high') countReliability = 'partial';
    }
  }
  const questions = [
    ...(overview.questions || []),
    ...tileResults.flatMap(({ result }) => result.questions || []),
    ...legendAware.verification.notes.filter((note) =>
      /ambiguous|could not be matched|provisional|Reliability:/i.test(note),
    ),
  ];
  const evidence = Array.from(new Set([
    ...(overview.evidence || []),
    ...tileResults.flatMap(({ result }) => result.evidence || []),
    ...items.map(item => item.evidence).filter((value): value is string => !!value),
    ...(legendEntries.length
      ? [`Legend types: ${legendEntries.map((e) => e.typeCode).join(', ')}`]
      : []),
  ]));

  onProgress?.(`Verifying page ${page} results...`, 90);
  const verifierPrompt = `Audit this construction-drawing detection manifest.
Do not invent or remove coordinates. Check whether counts equal the number of unique detections, flag low-confidence or conflicting identifications, and return JSON:
{"questions": string[], "evidence": string[]}

Page ${page}; text source: ${textEvidence.source}; detections:
${JSON.stringify(items.map(item => ({
    type: item.type,
    name: item.name,
    x: item.location.x,
    y: item.location.y,
    confidence: item.confidence,
    evidence: item.evidence,
  })))}`;
  const verifierResponse = await getAIService().complete('estimation', {
    messages: [
      { role: 'system', content: 'You verify construction blueprint detections. Return only valid JSON and preserve observed facts.' },
      { role: 'user', content: verifierPrompt },
    ],
    responseFormat: 'json',
    temperature: 0.1,
    maxTokens: 8192,
  });
  const verifier = parseJsonResponse(verifierResponse.content) as {
    questions?: unknown;
    evidence?: unknown;
  } | null;
  const verifiedQuestions = Array.isArray(verifier?.questions)
    ? verifier.questions.filter((value): value is string => typeof value === 'string')
    : [];
  const verifiedEvidence = Array.isArray(verifier?.evidence)
    ? verifier.evidence.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    overviewImage: bundle.overview.base64,
    textEvidence,
    skippedTiles,
    analysis: {
      ...overview,
      page,
      items,
      typeCounts,
      legendTypeCodes: legendEntries.map((e) => e.typeCode),
      legendTypeCounts: legendAware.legendTypeCounts,
      countReliability,
      countVerificationNotes: [
        ...(borrowedLegend && !borrowedLegend.ownPage ? [`Fixture types from the legend/schedule on ${borrowedLegend.sourceLabel}.`] : []),
        ...legendAware.verification.notes,
        ...extraNotes,
      ],
      questions: Array.from(new Set([...questions, ...verifiedQuestions])),
      evidence: Array.from(new Set([...evidence, ...verifiedEvidence])),
    },
  };
}

export interface PipelineResult {
  success: boolean;
  analysis?: BlueprintAnalysisResult[];
  estimate?: MaterialEstimate;
  placements?: CanvasPlacement;
  questions?: string[];
  evidence?: string[];
  questionOptions?: Array<{
    id: string;
    prompt: string;
    options: string[];
    allowMultiple?: boolean;
  }>;
  error?: string;
  duration: number;
}

/**
 * Run the full AI pipeline for blueprint analysis
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const startTime = Date.now();
  const aiService = getAIService();

  const {
    trade,
    pages,
    imageGenerator,
    pageWidth,
    pageHeight,
    userPrompt,
    trainingContext,
    location,
    onProgress,
    pdfDoc,
    highAccuracyMode = false,
    refinePlacements = true,
    visibleOnly = false,
    analysisRegion,
    getCachedText,
    setCachedText,
    resumeFrom,
  } = options;

  const reportProgress = (stage: PipelineProgress['stage'], progress: number, message: string, data?: unknown) => {
    onProgress?.({ stage, progress, message, data });
  };

  try {
    // Stage 1: Vision - Analyze blueprints
    reportProgress('vision', 0, resumeFrom ? 'Restoring prior page analysis...' : 'Starting blueprint analysis...');
    
    const analysisResults: BlueprintAnalysisResult[] = resumeFrom
      ? resumeFrom.analysis.map(result => ({
          ...result,
          // Clarifications were answered; do not ask the same questions again.
          questions: undefined,
          questionOptions: undefined,
        }))
      : [];
    
    if (!resumeFrom) for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageProgress = Math.round((i / pages.length) * 100);
      reportProgress('vision', pageProgress, `Analyzing page ${page}...`);

      // Every PDF-backed request now uses the same maximum-accuracy overview,
      // overlapping tile, text/OCR, reconciliation, and verification path.
      if (pdfDoc) {
        const maximumResult = await analyzePageMaximumAccuracy({
          pdfDoc,
          page,
          pageWidth,
          pageHeight,
          trade,
          userPrompt,
          trainingContext,
          visibleOnly,
          analysisRegion,
          getCachedText,
          setCachedText,
          onProgress: (message, progress) => reportProgress(
            'vision',
            Math.min(99, Math.round(((i + progress / 100) / pages.length) * 100)),
            message
          ),
        });
        analysisResults.push(maximumResult.analysis);
        continue;
      }
      
      // Get page image
      if (!imageGenerator) {
        throw new Error('Page image generator is required for a new pipeline analysis.');
      }
      const imageBase64 = await imageGenerator(page);
      const textContext = '';
      const promptParts = [
        visibleOnly ? 'VISIBLE-ONLY MODE: Count only symbols visible in the image. Ignore schedule/legend totals or text-only counts.' : undefined,
        userPrompt ? `User request: ${userPrompt}` : undefined,
        trainingContext ? trainingContext : undefined,
        textContext ? `PDF TEXT SNIPPETS:\n${textContext}` : undefined,
      ].filter(Boolean);
      const combinedPrompt = promptParts.join('\n\n');

      // Analyze full page with vision model
      const visionResponse = await aiService.analyzeBlueprint(
        imageBase64,
        trade,
        combinedPrompt || userPrompt
      );
      
      try {
        const analysisData = JSON.parse(visionResponse.content);
        const baseResult: BlueprintAnalysisResult = {
          page,
          items: analysisData.items || [],
          dimensions: analysisData.dimensions || [],
          text: analysisData.text || [],
          symbols: analysisData.symbols || [],
          typeCounts: analysisData.typeCounts || undefined,
          questions: analysisData.questions || undefined,
          questionOptions: analysisData.questionOptions || undefined,
          evidence: analysisData.evidence || undefined,
          location: analysisData.projectInfo?.address ? {
            address: analysisData.projectInfo.address,
          } : undefined,
        };

        if (!highAccuracyMode || !pdfDoc) {
          analysisResults.push(baseResult);
          continue;
        }

        reportProgress('vision', pageProgress, `High accuracy pass ${page}...`);

        const scheduleCrop = visibleOnly ? null : await extractScheduleCrop(pdfDoc, page, pageWidth, pageHeight);
        let scheduleResult: BlueprintAnalysisResult | null = null;

        if (scheduleCrop) {
          const scheduleImage = await capturePageCrop(pdfDoc, page, scheduleCrop, {
            scale: 2.4,
            format: 'jpeg',
            quality: 0.92,
          });
          const scheduleResponse = await aiService.analyzeBlueprint(
            scheduleImage.base64,
            trade,
            `${combinedPrompt}\n\nFocus on the lighting fixture schedule/legend only. Extract fixture types, descriptions, and any abbreviations.`
          );
          try {
            const scheduleData = JSON.parse(scheduleResponse.content);
            scheduleResult = {
              page,
              items: [],
              dimensions: [],
              text: [],
              symbols: [],
              typeCounts: scheduleData.typeCounts || undefined,
              questions: scheduleData.questions || undefined,
              questionOptions: scheduleData.questionOptions || undefined,
              evidence: scheduleData.evidence || undefined,
              location: undefined,
            };
          } catch (error) {
            console.warn('[AI] Failed to parse schedule response:', error);
          }
        }

        const tiles = generateTiles(pageWidth, pageHeight, 3, 3);
        const tileResults: BlueprintAnalysisResult[] = [];

        for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
          const tile = tiles[tileIndex];
          const tileImage = await capturePageCrop(pdfDoc, page, tile, {
            scale: 2.6,
            format: 'jpeg',
            quality: 0.9,
          });
          const tileResponse = await aiService.analyzeBlueprint(
            tileImage.base64,
            trade,
            `${combinedPrompt}\n\nFocus on counting fixtures/symbols in this selected area. Do not mention cropping.`
          );
          try {
            const tileData = JSON.parse(tileResponse.content);
            tileResults.push({
              page,
              items: tileData.items || [],
              dimensions: [],
              text: [],
              symbols: tileData.symbols || [],
              typeCounts: tileData.typeCounts || undefined,
              questions: tileData.questions || undefined,
              questionOptions: tileData.questionOptions || undefined,
              evidence: tileData.evidence || undefined,
              location: undefined,
            });
          } catch (error) {
            console.warn('[AI] Failed to parse tile response:', error);
          }
        }

        const mergedTypeCounts = mergeTypeCounts([
          baseResult.typeCounts,
          scheduleResult?.typeCounts,
          ...tileResults.map(result => result.typeCounts),
        ]);

        const mergedQuestions = [
          ...(baseResult.questions || []),
          ...(scheduleResult?.questions || []),
          ...tileResults.flatMap(result => result.questions || []),
        ];

        const mergedQuestionOptions = [
          ...(baseResult.questionOptions || []),
          ...(scheduleResult?.questionOptions || []),
          ...tileResults.flatMap(result => result.questionOptions || []),
        ];

        const mergedEvidence = [
          ...(baseResult.evidence || []),
          ...(scheduleResult?.evidence || []),
          ...tileResults.flatMap(result => result.evidence || []),
        ];

        analysisResults.push({
          ...baseResult,
          typeCounts: Object.keys(mergedTypeCounts).length ? mergedTypeCounts : baseResult.typeCounts,
          questions: mergedQuestions.length ? mergedQuestions : baseResult.questions,
          questionOptions: mergedQuestionOptions.length ? mergedQuestionOptions : baseResult.questionOptions,
          evidence: mergedEvidence.length ? mergedEvidence : baseResult.evidence,
        });
      } catch (parseError) {
        console.error('Failed to parse vision response:', parseError);
        // Continue with partial results
      }
    }

    reportProgress('vision', 100, 'Blueprint analysis complete', analysisResults);

    const questions = resumeFrom ? [] : analysisResults.flatMap(result => result.questions || []);
    const evidence = analysisResults.flatMap(result => result.evidence || []);
    const questionOptions = resumeFrom ? [] : analysisResults.flatMap(result => result.questionOptions || []);
    const totalItems = analysisResults.reduce((sum, result) => sum + (result.items?.length || 0), 0);
    const totalTypeCounts = analysisResults.reduce((sum, result) => sum + Object.keys(result.typeCounts || {}).length, 0);
    const askedForCounts = !!userPrompt && /count|how many|quantity|quantities|number of/i.test(userPrompt);

    if (!resumeFrom && askedForCounts && totalItems === 0 && totalTypeCounts === 0) {
      questions.push('I could not detect any fixtures to count. Are the lighting symbols visible on this page, or should I zoom into a specific area?');
    }

    if (!resumeFrom && highAccuracyMode && askedForCounts && totalTypeCounts > 0 && questions.length === 0) {
      const typeCounts = mergeTypeCounts(analysisResults.map(result => result.typeCounts));
      const variance = Object.values(typeCounts).some(value => value > 0);
      if (!variance) {
        questions.push('I could not confirm counts across tiles. Can you confirm the fixture symbols are clearly visible?');
      }
    }

    if (questions.length > 0 || questionOptions.length > 0) {
      reportProgress('complete', 100, 'Questions required', { questions, evidence, questionOptions });
      return {
        success: true,
        analysis: analysisResults,
        questions,
        evidence,
        questionOptions,
        duration: Date.now() - startTime,
      };
    }

    // Stage 2: Estimation - Generate material takeoff
    reportProgress('estimation', 0, 'Generating material estimate...');
    
    const estimationResponse = await aiService.estimateMaterials(
      JSON.stringify(resumeFrom
        ? {
            analysis: analysisResults,
            clarificationContext: resumeFrom.clarificationContext,
          }
        : analysisResults),
      trade,
      location
    );
    
    reportProgress('estimation', 50, 'Processing estimate...');
    
    let estimate: MaterialEstimate;
    try {
      const estimateData = parseJsonResponse(estimationResponse.content) as {
        items?: MaterialEstimate['items'];
        codeReferences?: MaterialEstimate['codeReferences'];
        notes?: string[];
      } | null;
      if (!estimateData) {
        throw new Error('Empty or invalid JSON');
      }
      estimate = {
        trade,
        items: estimateData.items || [],
        codeReferences: estimateData.codeReferences || [],
        notes: estimateData.notes || [],
      };
    } catch (parseError) {
      console.error('Failed to parse estimation response:', parseError);
      console.error('Estimation raw response:', estimationResponse.content);
      throw new Error('Failed to parse material estimate');
    }
    
    reportProgress('estimation', 100, 'Material estimate complete', estimate);

    // Stage 3: Placement - Generate canvas markups
    reportProgress('placement', 0, 'Generating canvas placements...');
    
    const placementResponse = await aiService.generatePlacements(
      JSON.stringify({
        analysis: analysisResults,
        estimate,
        clarificationContext: resumeFrom?.clarificationContext,
      }),
      pageWidth,
      pageHeight
    );
    
    reportProgress('placement', 50, 'Processing placements...');
    
    let placements: CanvasPlacement;
    try {
      const placementData = parseJsonResponse(placementResponse.content) as {
        markups?: CanvasPlacement['markups'];
        notes?: CanvasPlacement['notes'];
      } | null;
      if (!placementData) {
        throw new Error('Empty or invalid JSON');
      }
      placements = {
        markups: placementData.markups || [],
        notes: placementData.notes || [],
      };
    } catch (parseError) {
      console.error('Failed to parse placement response:', parseError);
      console.error('Placement raw response:', placementResponse.content);
      throw new Error('Failed to generate canvas placements');
    }
    
    if (refinePlacements && pdfDoc && placements.markups.length > 0) {
      reportProgress('placement', 75, 'Refining placement accuracy...');
      placements = await refinePlacementPoints({
        placements,
        pdfDoc,
        pageWidth,
        pageHeight,
        trade,
        userPrompt,
      });
    }
    
    reportProgress('placement', 100, 'Canvas placements complete', placements);
    reportProgress('complete', 100, 'Pipeline complete');

    return {
      success: true,
      analysis: analysisResults,
      estimate,
      placements,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    reportProgress('error', 0, errorMessage);
    
    return {
      success: false,
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Run only the vision stage for quick analysis
 */
export async function analyzeOnly(options: {
  trade: TradeType;
  imageBase64: string;
  userPrompt?: string;
}): Promise<BlueprintAnalysisResult | null> {
  const aiService = getAIService();
  
  try {
    const response = await aiService.analyzeBlueprint(
      options.imageBase64,
      options.trade,
      options.userPrompt
    );
    
    const data = parseJsonResponse(response.content) as {
      items?: BlueprintAnalysisResult['items'];
      dimensions?: BlueprintAnalysisResult['dimensions'];
      text?: BlueprintAnalysisResult['text'];
      symbols?: BlueprintAnalysisResult['symbols'];
      projectInfo?: { address?: string };
    } | null;
    if (!data) {
      throw new Error('Failed to parse analysis response');
    }
    return {
      page: 1,
      items: data.items || [],
      dimensions: data.dimensions || [],
      text: data.text || [],
      symbols: data.symbols || [],
      location: data.projectInfo?.address ? {
        address: data.projectInfo.address,
      } : undefined,
    };
  } catch (error) {
    console.error('Analysis failed:', error);
    return null;
  }
}

/**
 * Chat with the AI about the current document
 */
export async function chat(options: {
  message: string;
  context?: {
    trade?: TradeType;
    currentPage?: number;
    selectedItems?: unknown[];
    previousMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    markupsSummary?: string;
    catalogSummary?: string;
  };
  imageBase64?: string;
  pdfDoc?: PDFDocumentProxy;
  pageWidth?: number;
  pageHeight?: number;
  getCachedText?: (page: number) => TextItemWithBounds[];
  setCachedText?: (page: number, items: TextItemWithBounds[]) => void;
  onProgress?: (message: string, progress: number) => void;
}): Promise<{ text: string; markupPointers: ChatMarkupPointer[] }> {
  const aiService = getAIService();
  const page = options.context?.currentPage || 1;
  const maximumResult = !options.imageBase64 && options.pdfDoc && options.pageWidth && options.pageHeight
    ? await analyzePageMaximumAccuracy({
        pdfDoc: options.pdfDoc,
        page,
        pageWidth: options.pageWidth,
        pageHeight: options.pageHeight,
        trade: options.context?.trade || 'electrical',
        userPrompt: options.message,
        getCachedText: options.getCachedText,
        setCachedText: options.setCachedText,
        onProgress: options.onProgress,
      })
    : null;
  const effectiveImage = maximumResult?.overviewImage || options.imageBase64;
  const verifiedVisionContext = maximumResult
    ? `\nVerified maximum-accuracy page evidence:\n${JSON.stringify({
        page,
        textSource: maximumResult.textEvidence.source,
        textConfidence: maximumResult.textEvidence.confidence,
        typeCounts: maximumResult.analysis.typeCounts,
        detections: maximumResult.analysis.items.map(item => ({
          type: item.type,
          name: item.name,
          xPct: item.location.x,
          yPct: item.location.y,
          confidence: item.confidence,
          evidence: item.evidence,
        })),
        questions: maximumResult.analysis.questions,
        evidence: maximumResult.analysis.evidence,
        coordinateNote: 'Detection xPct/yPct are 0–100 percentages. Callout JSON must use DocPoint page points (scale 1), not percentages.',
      })}`
    : '';

  const pointerInstructions = effectiveImage
    ? `

Only place visual callouts when you intentionally need to point at something specific on the page.
If you do, mention each callout in your prose with a numbered ref like [1], and end with a fenced json block in this exact shape.
Coordinates are PDF page points at scale 1 (document points), top-left origin — NOT 0–100 percentages.
Page size for this sheet: ${options.pageWidth || '?'} × ${options.pageHeight || '?'} points.
\`\`\`json
{"callouts": [{"ref": 1, "point": {"x": 306.0, "y": 129.6}, "bounds": {"x": 280.8, "y": 100.8, "width": 50.4, "height": 57.6}, "label": "Timeclock", "note": "24hr timeclock on lighting control detail", "confidence": 0.94}]}
\`\`\`
Rules:
- Omit the callouts block entirely for ordinary Q&A that does not need pointing.
- Every callout MUST include a positive integer "ref" that also appears as [ref] in the written answer.
- Prefer "bounds" (AABB in page points) when the object outline is visible; otherwise use "point" for the tip of the leader.
- Use fractional page points for sub-point precision (e.g. 306.25). Do not emit xPct/yPct/boundsPct.
- Include at most 10 callouts and never mention the JSON block itself in your written answer.`
    : '';

  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; images?: string[] }> = [
    {
      role: 'system',
      content: `You are an AI assistant helping with construction blueprint takeoffs and estimates.
You have access to the user's PDF documents and can help with:
- Analyzing blueprints for materials and fixtures
- Counting items and generating estimates
- Suggesting optimal layouts for conduit, duct, and pipe runs
- Answering questions about building codes (NEC, UPC, IBC)
- Explaining trade-specific requirements

${options.context?.trade ? `Current trade focus: ${options.context.trade}` : ''}
${options.context?.currentPage ? `Current page: ${options.context.currentPage}` : ''}
${options.context?.markupsSummary ? `\nExisting markups on the current page:\n${options.context.markupsSummary}` : ''}
${options.context?.catalogSummary ? `\nUser's product/assembly catalog:\n${options.context.catalogSummary}` : ''}
${verifiedVisionContext}
${pointerInstructions}

Base document claims on the verified evidence above. State uncertainty when evidence conflicts or confidence is low.
Give concise conclusions and observable evidence. Do not expose private chain-of-thought or hidden reasoning.
Be helpful, accurate, and reference specific codes when applicable.`,
    },
  ];
  
  // Add previous messages for context
  if (options.context?.previousMessages) {
    messages.push(...options.context.previousMessages);
  }
  
  // Add current message
  if (effectiveImage) {
    messages.push({
      role: 'user',
      content: options.message,
      images: [effectiveImage],
    });
  } else {
    messages.push({
      role: 'user',
      content: options.message,
    });
  }
  
  try {
    let response;
    if (effectiveImage) {
      response = await aiService.vision({ messages });
    } else {
      response = await aiService.complete('estimation', { messages });
    }

    const extracted = extractChatMarkupPointers(response.content, {
      pageWidth: options.pageWidth,
      pageHeight: options.pageHeight,
    });
    if (!maximumResult) return extracted;

    // Snap intentional callouts onto verified detections when labels match.
    // Never invent callouts from mere name mentions in the answer text.
    return {
      text: extracted.text,
      markupPointers: snapIntentionalCalloutsToDetections(
        maximumResult.analysis,
        extracted.markupPointers,
        options.pageWidth && options.pageHeight
          ? { pageWidth: options.pageWidth, pageHeight: options.pageHeight }
          : undefined,
      ),
    };
  } catch (error) {
    console.error('Chat failed:', error);
    throw error;
  }
}

const MAX_CHAT_MARKUP_POINTERS = 10;

export function snapIntentionalCalloutsToDetections(
  analysis: BlueprintAnalysisResult,
  pointers: ChatMarkupPointer[],
  pageSize?: { pageWidth: number; pageHeight: number },
): ChatMarkupPointer[] {
  if (!pointers.length) return [];

  return pointers.map((pointer) => {
    const label = pointer.label?.trim().toLowerCase() || '';
    if (!label) return pointer;

    const match = analysis.items.find((item) => {
      const type = item.type.trim().toLowerCase();
      const name = item.name.trim().toLowerCase();
      return (name.length > 1 && (label.includes(name) || name.includes(label))) ||
        (type.length > 1 && (label.includes(type) || type.includes(label)));
    });

    if (!match) return pointer;

    const canConvert = pageSize
      && Number.isFinite(pageSize.pageWidth)
      && Number.isFinite(pageSize.pageHeight)
      && pageSize.pageWidth > 0
      && pageSize.pageHeight > 0;

    // DetectedItem location/boundingBox remain 0–100 vision percents; convert to DocPoint
    // only when page size is known. Never copy percents into DocPoint fields.
    const docFields = canConvert && pageSize
      ? detectionPctToDocPointerFields(
        match.location,
        match.boundingBox,
        pageSize.pageWidth,
        pageSize.pageHeight,
      )
      : null;

    return {
      ...pointer,
      type: 'callout',
      ...(docFields || {}),
      label: pointer.label || match.name,
      note: pointer.note || match.evidence || `Verified ${match.type} detection`,
      confidence: pointer.confidence ?? match.confidence,
    };
  });
}

/** @deprecated Use snapIntentionalCalloutsToDetections — substring auto-place is disabled. */
export function buildVerifiedCalloutPointers(
  analysis: BlueprintAnalysisResult,
  _responseText: string,
  intentionalPointers: ChatMarkupPointer[] = [],
  pageSize?: { pageWidth: number; pageHeight: number },
): ChatMarkupPointer[] {
  return snapIntentionalCalloutsToDetections(analysis, intentionalPointers, pageSize);
}

// Pulls an optional trailing intentional callouts JSON block out of a chat
// response, validating each pointer and stripping the raw JSON from user text.
function extractChatMarkupPointers(
  content: string,
  pageSize?: { pageWidth?: number; pageHeight?: number },
): { text: string; markupPointers: ChatMarkupPointer[] } {
  if (!content) return { text: content, markupPointers: [] };

  const fencedMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (!fencedMatch) return { text: content, markupPointers: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fencedMatch[1]);
  } catch {
    return { text: content, markupPointers: [] };
  }

  const parsedObject = parsed as { callouts?: unknown; markups?: unknown } | null;
  const rawMarkups = Array.isArray(parsedObject?.callouts)
    ? parsedObject.callouts
    : Array.isArray(parsedObject?.markups)
      ? parsedObject.markups
      : null;
  if (!rawMarkups) return { text: content, markupPointers: [] };

  const markupPointers: ChatMarkupPointer[] = [];
  for (const item of rawMarkups) {
    if (markupPointers.length >= MAX_CHAT_MARKUP_POINTERS) break;
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const pointer = parseChatMarkupPointerRow(candidate, {
      pageWidth: pageSize?.pageWidth,
      pageHeight: pageSize?.pageHeight,
    });
    if (!pointer) continue;
    markupPointers.push(pointer);
  }

  const text = content.slice(0, fencedMatch.index).trim();
  return { text: text || content.trim(), markupPointers };
}

function parseJsonResponse(content: string): unknown | null {
  if (!content) return null;
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // Strip markdown fences if present
    const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      try {
        return JSON.parse(fencedMatch[1].trim());
      } catch {
        // continue to fallback
      }
    }
    // Find first JSON object in the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function refinePlacementPoints(options: {
  placements: CanvasPlacement;
  pdfDoc: PDFDocumentProxy;
  pageWidth: number;
  pageHeight: number;
  trade: TradeType;
  userPrompt?: string;
}): Promise<CanvasPlacement> {
  const aiService = getAIService();
  const { placements, pdfDoc, pageWidth, pageHeight, trade, userPrompt } = options;
  
  const refinedMarkups = await Promise.all(
    placements.markups.map(async (markup, index) => {
      const point = markup.points?.[0];
      if (!point) return markup;
      
      const cropSize = 240;
      const cropX = Math.max(0, Math.min(point.x - cropSize / 2, pageWidth - cropSize));
      const cropY = Math.max(0, Math.min(point.y - cropSize / 2, pageHeight - cropSize));
      
      try {
        const crop = await capturePageCrop(
          pdfDoc,
          markup.page,
          { x: cropX, y: cropY, width: cropSize, height: cropSize },
          { scale: 2, format: 'jpeg', quality: 0.9 }
        );
        
        const refinementPrompt = `You are refining placement accuracy for construction takeoff markups.
Return the exact center point of the symbol within this cropped image.

Crop size: ${crop.width} x ${crop.height} pixels
Return JSON: { "x": number, "y": number }
Only return the JSON object.`;
        
        const response = await aiService.vision({
          messages: [
            { role: 'system', content: refinementPrompt },
            {
              role: 'user',
              content: `Trade: ${trade}. ${userPrompt || ''} Locate the exact symbol center.`,
              images: [crop.base64],
            },
          ],
          responseFormat: 'json',
          temperature: 0.1,
        });
        
        const refined = parseJsonResponse(response.content) as { x?: unknown; y?: unknown } | null;
        if (!refined || typeof refined.x !== 'number' || typeof refined.y !== 'number') {
          return markup;
        }
        
        const refinedPoint = {
          x: Math.max(0, Math.min(pageWidth, cropX + refined.x / crop.scale)),
          y: Math.max(0, Math.min(pageHeight, cropY + refined.y / crop.scale)),
        };
        
        return {
          ...markup,
          points: [refinedPoint, ...markup.points.slice(1)],
        };
      } catch (error) {
        console.warn('Placement refinement failed for markup', index, error);
        return markup;
      }
    })
  );
  
  return {
    ...placements,
    markups: refinedMarkups,
  };
}

/**
 * Generate layout suggestions for a specific trade
 */
export async function suggestLayouts(options: {
  trade: TradeType;
  layoutType: 'conduit' | 'homerun' | 'duct' | 'pipe' | 'vent';
  imageBase64: string;
  existingItems?: unknown[];
  constraints?: string;
}): Promise<LayoutSuggestion[]> {
  const aiService = getAIService();
  
  const systemPrompt = `You are an expert ${options.trade} layout designer.
Generate ${options.layoutType} layout suggestions that:
- Minimize material usage while meeting code requirements
- Follow optimal routing patterns
- Account for structural obstacles
- Consider accessibility for maintenance

Provide 2-3 alternative layouts with pros/cons for each.

Respond with JSON:
{
  "suggestions": [
    {
      "id": "unique-id",
      "trade": "${options.trade}",
      "type": "${options.layoutType}",
      "name": "Layout Option 1",
      "description": "Description of this layout approach",
      "routes": [
        {
          "id": "route-id",
          "points": [{ "x": 10, "y": 20 }, { "x": 50, "y": 20 }],
          "page": 1,
          "segments": [
            {
              "start": { "x": 10, "y": 20 },
              "end": { "x": 50, "y": 20 },
              "length": 40,
              "type": "straight"
            }
          ]
        }
      ],
      "totalLength": 40,
      "codeCompliance": true,
      "notes": ["Key notes about this layout"]
    }
  ]
}`;

  try {
    const response = await aiService.vision({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: options.constraints || `Suggest optimal ${options.layoutType} layouts for this blueprint.`,
          images: [options.imageBase64],
        },
      ],
      responseFormat: 'json',
      temperature: 0.3,
    });
    
    const data = JSON.parse(response.content);
    return data.suggestions || [];
  } catch (error) {
    console.error('Layout suggestion failed:', error);
    return [];
  }
}
