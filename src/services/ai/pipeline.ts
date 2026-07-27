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
import {
  getTextContentWithBounds,
  groupTextIntoLines,
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
  imageGenerator: (page: number) => Promise<string>; // Function to get page image as base64
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

function normalizeAnalysis(
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
    return {
      id: typeof candidate.id === 'string' ? candidate.id : `detected_${page}_${index}`,
      type: typeof candidate.type === 'string' ? candidate.type : 'unknown',
      trade,
      name: typeof candidate.name === 'string'
        ? candidate.name
        : (typeof candidate.type === 'string' ? candidate.type : 'Unknown item'),
      quantity: 1,
      location: {
        x: normalizePercent(location.x),
        y: normalizePercent(location.y),
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

function mapTileItemToPage(
  item: BlueprintAnalysisResult['items'][number],
  region: PageTileRegion,
  pageWidth: number,
  pageHeight: number
): BlueprintAnalysisResult['items'][number] {
  const localX = normalizePercent(item.location.x);
  const localY = normalizePercent(item.location.y);
  const pageX = region.x + (localX / 100) * region.width;
  const pageY = region.y + (localY / 100) * region.height;
  const bounds = item.boundingBox;

  return {
    ...item,
    id: `${region.id}_${item.id}`,
    quantity: 1,
    location: {
      ...item.location,
      x: (pageX / pageWidth) * 100,
      y: (pageY / pageHeight) * 100,
      width: item.location.width === undefined
        ? undefined
        : (item.location.width / 100) * region.width / pageWidth * 100,
      height: item.location.height === undefined
        ? undefined
        : (item.location.height / 100) * region.height / pageHeight * 100,
    },
    boundingBox: bounds
      ? {
          x: ((region.x + (bounds.x / 100) * region.width) / pageWidth) * 100,
          y: ((region.y + (bounds.y / 100) * region.height) / pageHeight) * 100,
          width: ((bounds.width / 100) * region.width / pageWidth) * 100,
          height: ((bounds.height / 100) * region.height / pageHeight) * 100,
        }
      : undefined,
  };
}

function isOwnedByTile(
  item: BlueprintAnalysisResult['items'][number],
  region: PageTileRegion,
  pageWidth: number,
  pageHeight: number
): boolean {
  const pageX = (item.location.x / 100) * pageWidth;
  const pageY = (item.location.y / 100) * pageHeight;
  const right = region.ownership.x + region.ownership.width;
  const bottom = region.ownership.y + region.ownership.height;
  return pageX >= region.ownership.x && pageX <= right &&
    pageY >= region.ownership.y && pageY <= bottom;
}

function normalizedType(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function detectionsOverlap(
  left: BlueprintAnalysisResult['items'][number],
  right: BlueprintAnalysisResult['items'][number]
): boolean {
  if (normalizedType(left.type) !== normalizedType(right.type)) return false;
  const dx = left.location.x - right.location.x;
  const dy = left.location.y - right.location.y;
  return Math.hypot(dx, dy) <= 1.5;
}

export function reconcileTileDetections(
  tileResults: Array<{ region: PageTileRegion; result: BlueprintAnalysisResult }>,
  pageWidth: number,
  pageHeight: number
): BlueprintAnalysisResult['items'] {
  const candidates = tileResults.flatMap(({ region, result }) =>
    result.items
      .map(item => mapTileItemToPage(item, region, pageWidth, pageHeight))
      .filter(item => isOwnedByTile(item, region, pageWidth, pageHeight))
  );
  const reconciled: BlueprintAnalysisResult['items'] = [];

  candidates
    .sort((a, b) => b.confidence - a.confidence)
    .forEach(candidate => {
      if (!reconciled.some(existing => detectionsOverlap(existing, candidate))) {
        reconciled.push(candidate);
      }
    });

  return reconciled;
}

function countsFromDetections(items: BlueprintAnalysisResult['items']): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = item.type || item.name || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

export interface MaximumAccuracyPageResult {
  analysis: BlueprintAnalysisResult;
  overviewImage: string;
  textEvidence: PageTextEvidence;
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
  } = options;

  onProgress?.(`Rendering high-resolution page ${page}...`, 5);
  const [bundle, textEvidence] = await Promise.all([
    capturePageVisionBundle(pdfDoc, page, pageWidth, pageHeight, { region: analysisRegion }),
    extractPageTextEvidence(pdfDoc, page, pageWidth, pageHeight, getCachedText, setCachedText),
  ]);
  const textContext = visibleOnly || !textEvidence.context
    ? ''
    : `${textEvidence.source === 'ocr' ? 'OCR' : 'Native PDF'} text evidence:\n${textEvidence.context}`;
  const commonContext = [
    visibleOnly
      ? 'VISIBLE-ONLY MODE: Count only physical symbols visible in the drawing. Never use schedule rows as quantities.'
      : 'Use schedules and legends only to identify symbol types; never treat schedule rows as placed quantities.',
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
      items: overview.items.map(item => mapTileItemToPage(item, overviewRegion, pageWidth, pageHeight)),
    };
  }

  const tileResults: Array<{ region: PageTileRegion; result: BlueprintAnalysisResult }> = [];
  for (let index = 0; index < bundle.tiles.length; index += 1) {
    const tile = bundle.tiles[index];
    onProgress?.(
      `Analyzing page ${page} detail tile ${index + 1}/${bundle.tiles.length}...`,
      15 + Math.round(((index + 1) / bundle.tiles.length) * 60)
    );
    const result = await requestStructuredAnalysis(
      tile.base64,
      trade,
      `${commonContext}\n\nDETAIL TILE ${tile.region.id}: Find every physical instance visible in this crop. ` +
      'Return one item per physical symbol with quantity 1, center location and boundingBox in 0-100 coordinates relative to this tile, confidence, and visual evidence. ' +
      'Do not count schedule/legend rows as installed items.',
      page
    );
    tileResults.push({ region: tile.region, result });
  }

  onProgress?.(`Reconciling page ${page} detections...`, 80);
  const tileItems = reconcileTileDetections(tileResults, pageWidth, pageHeight);
  const items = tileItems.length > 0 ? tileItems : overview.items;
  const typeCounts = countsFromDetections(items);
  const questions = [
    ...(overview.questions || []),
    ...tileResults.flatMap(({ result }) => result.questions || []),
  ];
  const evidence = Array.from(new Set([
    ...(overview.evidence || []),
    ...tileResults.flatMap(({ result }) => result.evidence || []),
    ...items.map(item => item.evidence).filter((value): value is string => !!value),
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
    analysis: {
      ...overview,
      page,
      items,
      typeCounts,
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
  } = options;

  const reportProgress = (stage: PipelineProgress['stage'], progress: number, message: string, data?: unknown) => {
    onProgress?.({ stage, progress, message, data });
  };

  try {
    // Stage 1: Vision - Analyze blueprints
    reportProgress('vision', 0, 'Starting blueprint analysis...');
    
    const analysisResults: BlueprintAnalysisResult[] = [];
    
    for (let i = 0; i < pages.length; i++) {
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

    const questions = analysisResults.flatMap(result => result.questions || []);
    const evidence = analysisResults.flatMap(result => result.evidence || []);
    const questionOptions = analysisResults.flatMap(result => result.questionOptions || []);
    const totalItems = analysisResults.reduce((sum, result) => sum + (result.items?.length || 0), 0);
    const totalTypeCounts = analysisResults.reduce((sum, result) => sum + Object.keys(result.typeCounts || {}).length, 0);
    const askedForCounts = !!userPrompt && /count|how many|quantity|quantities|number of/i.test(userPrompt);

    if (askedForCounts && totalItems === 0 && totalTypeCounts === 0) {
      questions.push('I could not detect any fixtures to count. Are the lighting symbols visible on this page, or should I zoom into a specific area?');
    }

    if (highAccuracyMode && askedForCounts && totalTypeCounts > 0 && questions.length === 0) {
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
      JSON.stringify(analysisResults),
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
      })}`
    : '';

  const pointerInstructions = effectiveImage
    ? `

Only place visual callouts when you intentionally need to point at something specific on the page.
If you do, mention each callout in your prose with a numbered ref like [1], and end with a fenced json block in this exact shape (percentages, top-left origin):
\`\`\`json
{"callouts": [{"ref": 1, "xPct": 42.5, "yPct": 18.0, "boundsPct": {"x": 39, "y": 14, "width": 7, "height": 8}, "label": "Timeclock", "note": "24hr timeclock on lighting control detail", "confidence": 0.94}]}
\`\`\`
Rules:
- Omit the callouts block entirely for ordinary Q&A that does not need pointing.
- Every callout MUST include a positive integer "ref" that also appears as [ref] in the written answer.
- Prefer boundsPct when the object outline is visible; otherwise use xPct/yPct for the tip of the leader.
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

    const extracted = extractChatMarkupPointers(response.content);
    if (!maximumResult) return extracted;

    // Snap intentional callouts onto verified detections when labels match.
    // Never invent callouts from mere name mentions in the answer text.
    return {
      text: extracted.text,
      markupPointers: snapIntentionalCalloutsToDetections(
        maximumResult.analysis,
        extracted.markupPointers
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
  pointers: ChatMarkupPointer[]
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

    return {
      ...pointer,
      type: 'callout',
      xPct: match.location.x,
      yPct: match.location.y,
      boundsPct: match.boundingBox,
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
  intentionalPointers: ChatMarkupPointer[] = []
): ChatMarkupPointer[] {
  return snapIntentionalCalloutsToDetections(analysis, intentionalPointers);
}

// Pulls an optional trailing intentional callouts JSON block out of a chat
// response, validating each pointer and stripping the raw JSON from user text.
function extractChatMarkupPointers(content: string): { text: string; markupPointers: ChatMarkupPointer[] } {
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
    const ref = Number(candidate.ref);
    if (!Number.isInteger(ref) || ref < 1) continue;

    const xPct = Number(candidate.xPct);
    const yPct = Number(candidate.yPct);
    if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) continue;
    if (xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100) continue;

    const rawBounds = candidate.boundsPct;
    const bounds = rawBounds && typeof rawBounds === 'object'
      ? rawBounds as Record<string, unknown>
      : null;
    const boundsPct = bounds
      ? {
          x: Number(bounds.x),
          y: Number(bounds.y),
          width: Number(bounds.width),
          height: Number(bounds.height),
        }
      : undefined;
    const validBounds = boundsPct &&
      Number.isFinite(boundsPct.x) &&
      Number.isFinite(boundsPct.y) &&
      Number.isFinite(boundsPct.width) &&
      Number.isFinite(boundsPct.height) &&
      boundsPct.width > 0 &&
      boundsPct.height > 0;

    markupPointers.push({
      type: 'callout',
      ref,
      xPct,
      yPct,
      boundsPct: validBounds ? {
        x: Math.max(0, Math.min(100, boundsPct.x)),
        y: Math.max(0, Math.min(100, boundsPct.y)),
        width: Math.max(0.1, Math.min(100, boundsPct.width)),
        height: Math.max(0.1, Math.min(100, boundsPct.height)),
      } : undefined,
      label: typeof candidate.label === 'string' ? candidate.label : undefined,
      note: typeof candidate.note === 'string' ? candidate.note : undefined,
      confidence: Number.isFinite(Number(candidate.confidence))
        ? Math.max(0, Math.min(1, Number(candidate.confidence)))
        : undefined,
    });
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
