import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { useProductStore } from '@/store/productStore';
import { summarizeCatalogForChat, summarizeMarkupsForChat } from '../contextSummary';
import { suggestLayoutsFromItems } from '../layouts';
import { analyzePageMaximumAccuracy, extractPageTextEvidence } from '../pipeline';
import { BASE_RENDER_SCALE, clampDocRect, createPageGeometry } from '../placement/coords';
import type { DocRect } from '../placement/types';
import type { DetectedItem, TradeType } from '../providers/types';
import type { AssistantToolContext } from '../tools/types';
import type { CanvasMarkup } from '@/types/markup';
import { searchTextItemsWithBounds } from './searchTextItems';
import {
  buildAnalyzeCacheKey,
  buildExtractCacheKey,
  countItemsFromAnalysis,
  getCachedAnalyze,
  getCachedExtract,
  getLatestFullPageAnalysis,
  regionKeyFromRect,
  setCachedAnalyze,
  setCachedExtract,
  type CachedAnalyzePageResult,
  type CachedExtractPageTextResult,
} from './pageAnalysisCache';
import {
  activateEditorToolOnCanvas,
  executeDeleteMarkups,
  executeUpdateMarkups,
} from './markupMutations';
import { searchCatalog } from '../catalog/searchCatalog';
import { executeLinkCatalog } from '../catalog/attachProductToMarkup';

export interface CreateAgentToolContextOptions {
  runId: string;
  messageId: string;
  signal?: AbortSignal;
  trade: TradeType;
  placeMarkups: (payload: unknown) => Promise<unknown> | unknown;
  saveProjectDraft?: () => Promise<{ saved: boolean; path?: string | null; reason?: string }>;
  lastSaveStatus?: () => { saved: boolean; path?: string | null; at?: string };
  analyzePage?: (input: unknown) => Promise<unknown>;
  extractPageText?: (input: unknown) => Promise<unknown>;
  countPageItems?: (input: unknown) => Promise<unknown>;
  searchDocument?: (query: string) => Promise<import('@/types/assistant').EvidenceCitation[]>;
  navigateToPage?: (page: number, bounds?: { x: number; y: number; width: number; height: number }) => void;
  activateEditorTool?: (tool: string) => void;
  projectPath?: string | null;
}

type AnalyzePageScope = 'full' | 'viewport' | 'selection';

/** Minimum usable region size in document points (DocRect / page-point space). */
const MIN_ANALYSIS_REGION_POINTS = 1;

/**
 * Clamp a viewport/selection rect to the page and reject zero/near-zero area.
 * Canvas viewport math can yield width/height 0; imageCapture coerces those to 1px
 * crops rather than failing — so we gate here before calling the vision pipeline.
 */
function normalizeScopedAnalysisRegion(
  rect: DocRect,
  page: number,
  pageWidth: number,
  pageHeight: number,
): DocRect | null {
  const pageGeometry = createPageGeometry({
    pageNumber: page,
    docWidth: pageWidth,
    docHeight: pageHeight,
  });
  const clamped = clampDocRect(rect, pageGeometry);
  if (
    !Number.isFinite(clamped.width)
    || !Number.isFinite(clamped.height)
    || clamped.width < MIN_ANALYSIS_REGION_POINTS
    || clamped.height < MIN_ANALYSIS_REGION_POINTS
  ) {
    return null;
  }
  return clamped;
}

/**
 * Default analyze_page adapter: runs the Takeoff maximum-accuracy pipeline on the
 * active PDF. Returns a compact payload (no overviewImage base64). Override via
 * CreateAgentToolContextOptions.analyzePage for tests.
 */
async function defaultAnalyzePage(
  input: unknown,
  options: { trade: TradeType; signal?: AbortSignal },
): Promise<unknown> {
  if (options.signal?.aborted) {
    throw new DOMException('Assistant run cancelled', 'AbortError');
  }

  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const page = typeof raw.page === 'number' && Number.isInteger(raw.page) && raw.page > 0
    ? raw.page
    : null;
  const scope: AnalyzePageScope =
    raw.scope === 'viewport' || raw.scope === 'selection' || raw.scope === 'full'
      ? raw.scope
      : 'full';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : undefined;

  if (page == null) {
    return {
      status: 'unavailable',
      message: 'analyze_page requires a positive page number.',
    };
  }

  const canvas = useCanvasStore.getState();
  const docId = canvas.activeDocId;
  const pdfData = docId ? canvas.pdfDocuments[docId] : null;
  const pdfDoc = pdfData?.pdfDocument;
  const pageWidth = pdfData?.originalPageWidth;
  const pageHeight = pdfData?.originalPageHeight;
  const totalPages = pdfData?.totalPages || 0;

  if (!docId || !pdfDoc || !pageWidth || !pageHeight) {
    return {
      status: 'unavailable',
      message: 'No PDF document is open for page analysis.',
    };
  }

  if (page > totalPages) {
    return {
      status: 'unavailable',
      message: `Page ${page} is out of range (document has ${totalPages} page${totalPages === 1 ? '' : 's'}).`,
    };
  }

  let analysisRegion: DocRect | undefined;
  if (scope === 'selection') {
    const rect = canvas.getAiSelectionForPage(docId, page);
    if (!rect) {
      return {
        status: 'unavailable',
        message: 'Select a region on the canvas before analyzing with scope "selection".',
      };
    }
    const normalized = normalizeScopedAnalysisRegion(rect, page, pageWidth, pageHeight);
    if (!normalized) {
      return {
        status: 'unavailable',
        message: 'The selected region has no usable area on this page. Draw a larger selection and retry.',
      };
    }
    analysisRegion = normalized;
  } else if (scope === 'viewport') {
    const rect = canvas.getAiViewportForPage(docId, page);
    if (!rect) {
      return {
        status: 'unavailable',
        message: 'Unable to determine the visible viewport for scope "viewport". Try zooming or fit-to-canvas and retry.',
      };
    }
    const normalized = normalizeScopedAnalysisRegion(rect, page, pageWidth, pageHeight);
    if (!normalized) {
      return {
        status: 'unavailable',
        message: 'The visible viewport has no usable area on this page. Try zooming or fit-to-canvas and retry.',
      };
    }
    analysisRegion = normalized;
  }

  if (options.signal?.aborted) {
    throw new DOMException('Assistant run cancelled', 'AbortError');
  }

  const startedRevision = pdfData.contentRevision ?? 0;
  const cacheKey = buildAnalyzeCacheKey({
    docId,
    page,
    scope,
    trade: options.trade,
    contentRevision: startedRevision,
    prompt,
    pageWidth,
    pageHeight,
    regionKey: regionKeyFromRect(analysisRegion),
  });
  const cached = getCachedAnalyze(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const result = await analyzePageMaximumAccuracy({
      pdfDoc,
      page,
      pageWidth,
      pageHeight,
      trade: options.trade,
      userPrompt: prompt,
      analysisRegion,
      getCachedText: canvas.getTextContent,
      setCachedText: canvas.setTextContent,
    });

    // Compact agent payload: omit overviewImage (large base64) to avoid token bloat.
    const payload: CachedAnalyzePageResult = {
      status: 'completed',
      page,
      scope,
      analysis: result.analysis,
      textEvidence: {
        source: result.textEvidence.source,
        confidence: result.textEvidence.confidence,
        context: result.textEvidence.context,
        itemCount: result.textEvidence.items.length,
      },
    };

    // Post-await revision guard: document may have been edited (insert/delete/rotate)
    // while vision was in flight. Never cache (or promote) results for a stale revision.
    const liveRevision = useCanvasStore.getState().pdfDocuments[docId]?.contentRevision ?? 0;
    if (liveRevision !== startedRevision) {
      console.debug(
        '[pageAnalysisCache] discarding analyze_page result: document revision changed during analysis',
        { docId, page, startedRevision, liveRevision },
      );
      return {
        status: 'unavailable',
        message: 'Document content changed during analysis; results discarded. Retry analyze_page / count_page_items.',
        page,
        scope,
        discarded: true,
      };
    }

    const isBroadFullPage = scope === 'full' && !(prompt && prompt.trim());
    setCachedAnalyze(cacheKey, payload, {
      docId,
      page,
      scope,
      contentRevision: startedRevision,
      promoteToLatestFull: isBroadFullPage,
    });
    return payload;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error instanceof DOMException ? error : new DOMException('Assistant run cancelled', 'AbortError');
    }
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
      page,
      scope,
    };
  }
}

/**
 * Default extract_page_text adapter: native PDF text layer with OCR fallback via
 * extractPageTextEvidence. Override via CreateAgentToolContextOptions.extractPageText for tests.
 */
async function defaultExtractPageText(
  input: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  if (options.signal?.aborted) {
    throw new DOMException('Assistant run cancelled', 'AbortError');
  }

  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const page = typeof raw.page === 'number' && Number.isInteger(raw.page) && raw.page > 0
    ? raw.page
    : null;

  if (page == null) {
    return {
      status: 'unavailable',
      message: 'extract_page_text requires a positive page number.',
    };
  }

  const canvas = useCanvasStore.getState();
  const docId = canvas.activeDocId;
  const pdfData = docId ? canvas.pdfDocuments[docId] : null;
  const pdfDoc = pdfData?.pdfDocument;
  const pageWidth = pdfData?.originalPageWidth;
  const pageHeight = pdfData?.originalPageHeight;
  const totalPages = pdfData?.totalPages || 0;

  if (!docId || !pdfDoc || !pageWidth || !pageHeight) {
    return {
      status: 'unavailable',
      message: 'No PDF document is open for page text extraction.',
    };
  }

  if (page > totalPages) {
    return {
      status: 'unavailable',
      message: `Page ${page} is out of range (document has ${totalPages} page${totalPages === 1 ? '' : 's'}).`,
    };
  }

  if (options.signal?.aborted) {
    throw new DOMException('Assistant run cancelled', 'AbortError');
  }

  const startedRevision = pdfData.contentRevision ?? 0;
  const cacheKey = buildExtractCacheKey({
    docId,
    page,
    contentRevision: startedRevision,
    pageWidth,
    pageHeight,
  });
  const cached = getCachedExtract(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const evidence = await extractPageTextEvidence(
      pdfDoc,
      page,
      pageWidth,
      pageHeight,
      canvas.getTextContent,
      canvas.setTextContent,
    );

    const payload: CachedExtractPageTextResult = {
      status: 'completed',
      page,
      source: evidence.source,
      confidence: evidence.confidence,
      context: evidence.context,
      itemCount: evidence.items.length,
      // Real bounded text items from native/OCR extraction (no fabricated content).
      items: evidence.items,
    };

    const liveRevision = useCanvasStore.getState().pdfDocuments[docId]?.contentRevision ?? 0;
    if (liveRevision !== startedRevision) {
      console.debug(
        '[pageAnalysisCache] discarding extract_page_text result: document revision changed during extraction',
        { docId, page, startedRevision, liveRevision },
      );
      return {
        status: 'unavailable',
        message: 'Document content changed during text extraction; results discarded. Retry extract_page_text.',
        page,
        discarded: true,
      };
    }

    setCachedExtract(cacheKey, payload);
    return payload;
  } catch (error) {
    if (options.signal?.aborted) {
      throw error instanceof DOMException ? error : new DOMException('Assistant run cancelled', 'AbortError');
    }
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
      page,
    };
  }
}

/**
 * Count / filter detections from a cached (or freshly run) full-page analysis.
 * Prefer this over re-calling analyze_page for "how many lights / Type A" questions.
 */
async function defaultCountPageItems(
  input: unknown,
  options: { trade: TradeType; signal?: AbortSignal },
): Promise<unknown> {
  if (options.signal?.aborted) {
    throw new DOMException('Assistant run cancelled', 'AbortError');
  }

  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const page = typeof raw.page === 'number' && Number.isInteger(raw.page) && raw.page > 0
    ? raw.page
    : null;
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';

  if (page == null) {
    return {
      status: 'unavailable',
      message: 'count_page_items requires a positive page number.',
    };
  }

  const canvas = useCanvasStore.getState();
  const docId = canvas.activeDocId;
  if (!docId) {
    return {
      status: 'unavailable',
      message: 'No PDF document is open for counting page items.',
    };
  }

  const pdfData = canvas.pdfDocuments[docId];
  const contentRevision = pdfData?.contentRevision ?? 0;
  const cached = getLatestFullPageAnalysis(docId, page, contentRevision);
  if (cached?.analysis) {
    return countItemsFromAnalysis(cached.analysis, query, { source: 'cache' });
  }

  // Cache miss: ALWAYS run a broad, unprompted full-page analysis, then filter
  // client-side. Never steer vision with the count query — that would bias the
  // canonical latestFull cache toward one item type and undercount later queries.
  const analyzed = await defaultAnalyzePage(
    { page, scope: 'full' },
    options,
  ) as CachedAnalyzePageResult | { status: string; message?: string };

  if (analyzed.status !== 'completed' || !('analysis' in analyzed) || !analyzed.analysis) {
    return {
      status: 'unavailable',
      page,
      query,
      source: 'none',
      message: ('message' in analyzed && analyzed.message)
        || 'Could not analyze the page before counting.',
    };
  }

  return countItemsFromAnalysis(analyzed.analysis, query, { source: 'fresh_analysis' });
}

/**
 * Bind Zustand stores into an AssistantToolContext for the agent runner.
 */
export function createAgentToolContext(options: CreateAgentToolContextOptions): AssistantToolContext {
  const getDocMeta = () => {
    const canvas = useCanvasStore.getState();
    const editor = useEditorStore.getState();
    const docId = canvas.activeDocId;
    const page = canvas.getCurrentPage();
    const pdf = docId ? canvas.pdfDocuments[docId] : null;
    const document = editor.documents.find(d => d.id === editor.activeDocument);
    return { canvas, editor, docId, page, pdf, document };
  };

  return {
    runId: options.runId,
    messageId: options.messageId,
    signal: options.signal,
    addApproval: approval => useAIChatStore.getState().addApproval(approval),

    getDocumentContext: () => {
      const { docId, page, pdf, document } = getDocMeta();
      return {
        documentId: docId,
        documentName: document?.name || null,
        page,
        totalPages: pdf?.totalPages || 0,
        pageWidth: pdf?.originalPageWidth || null,
        pageHeight: pdf?.originalPageHeight || null,
        projectPath: options.projectPath || null,
      };
    },

    getProjectContext: () => {
      const base = getDocMeta();
      return {
        ...(typeof base === 'object' ? {
          documentId: base.docId,
          documentName: base.document?.name || null,
          page: base.page,
          totalPages: base.pdf?.totalPages || 0,
        } : {}),
        projectPath: options.projectPath || null,
        trade: options.trade,
        screen: 'editor',
      };
    },

    analyzePage: options.analyzePage || (input => defaultAnalyzePage(input, {
      trade: options.trade,
      signal: options.signal,
    })),

    extractPageText: options.extractPageText || (input => defaultExtractPageText(input, {
      signal: options.signal,
    })),

    countPageItems: options.countPageItems || (input => defaultCountPageItems(input, {
      trade: options.trade,
      signal: options.signal,
    })),

    searchDocument: options.searchDocument || (async query => {
      const { page, docId } = getDocMeta();
      if (!page) return [];
      const textItems = useCanvasStore.getState().getTextContent(page) || [];
      // Canvas text cache is typically at BASE_RENDER_SCALE (1.5). AI selection /
      // navigate_page expect document points (scale 1).
      const citations = searchTextItemsWithBounds({
        query,
        page,
        documentId: docId || undefined,
        textItems,
      });
      return citations.map(citation => {
        if (!citation.bounds) return citation;
        return {
          ...citation,
          bounds: {
            x: citation.bounds.x / BASE_RENDER_SCALE,
            y: citation.bounds.y / BASE_RENDER_SCALE,
            width: citation.bounds.width / BASE_RENDER_SCALE,
            height: citation.bounds.height / BASE_RENDER_SCALE,
          },
        };
      });
    }),

    inspectCatalog: () => {
      const { nodes, rootIds, activeProductId } = useProductStore.getState();
      return {
        summary: summarizeCatalogForChat(nodes, rootIds, activeProductId),
        activeProductId,
        productCount: Object.keys(nodes).length,
      };
    },

    searchCatalog: (input) => {
      const record = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
      return searchCatalog({
        query: typeof record.query === 'string' ? record.query : '',
        category: typeof record.category === 'string' ? record.category : undefined,
        limit: typeof record.limit === 'number' ? record.limit : undefined,
        productsOnly: record.productsOnly !== false,
      });
    },

    inspectMarkups: () => {
      const { docId, page } = getDocMeta();
      if (!docId) return { summary: '', markups: [] };
      const markupsByPage = useCanvasStore.getState().getMarkupsByPage(docId);
      return {
        page,
        summary: summarizeMarkupsForChat(markupsByPage, page || 1),
        count: (markupsByPage[page || 1] || []).length,
      };
    },

    getTakeoffSummary: () => {
      const { docId, page } = getDocMeta();
      if (!docId) return { summary: 'No document open.' };
      const markupsByPage = useCanvasStore.getState().getMarkupsByPage(docId);
      const allPages = Object.keys(markupsByPage).map(Number);
      const pageSummaries = allPages.slice(0, 10).map(p => ({
        page: p,
        summary: summarizeMarkupsForChat(markupsByPage, p),
      }));
      return {
        activePage: page,
        pages: pageSummaries,
        activePageSummary: summarizeMarkupsForChat(markupsByPage, page || 1),
      };
    },

    getMaterialCounts: () => {
      const exported = useProductStore.getState().exportProducts('agent');
      const products = (exported.products || []).map(product => ({
        id: product.id,
        name: product.name,
        path: product.path,
        totalLength: product.measurements?.totalLength ?? 0,
        totalArea: product.measurements?.totalArea ?? 0,
        totalCount: product.measurements?.totalCount ?? 0,
        details: product.measurements?.details || [],
      }));
      return { products, exportDate: exported.exportDate };
    },

    getConversationContext: () => {
      const messages = useAIChatStore.getState().messages
        .filter(m => !m.isLoading && (m.role === 'user' || m.role === 'assistant'))
        .slice(-8)
        .map(m => ({ role: m.role, content: (m.content || '').slice(0, 500) }));
      return { turns: messages };
    },

    getLayoutSuggestions: async (input: unknown) => {
      const layoutType = (input as { layoutType?: string })?.layoutType || 'conduit';
      const { docId, page, pdf } = getDocMeta();
      const markups: CanvasMarkup[] = docId
        ? (useCanvasStore.getState().getMarkupsByPage(docId)[page || 1] || [])
        : [];
      const items = markupsToDetectedItems(markups, options.trade);
      return suggestLayoutsFromItems(items, {
        trade: options.trade,
        layoutType: layoutType as 'conduit' | 'homerun' | 'duct' | 'pipe' | 'vent',
        pageWidth: pdf?.originalPageWidth || 1000,
        pageHeight: pdf?.originalPageHeight || 1000,
      });
    },

    getRunSuggestions: async (input: unknown) => {
      const layoutType = (input as { layoutType?: string })?.layoutType || 'homerun';
      const { docId, page, pdf } = getDocMeta();
      const markups: CanvasMarkup[] = docId
        ? (useCanvasStore.getState().getMarkupsByPage(docId)[page || 1] || [])
        : [];
      const items = markupsToDetectedItems(markups, options.trade);
      return suggestLayoutsFromItems(items, {
        trade: options.trade,
        layoutType: layoutType as 'conduit' | 'homerun' | 'duct' | 'pipe' | 'vent',
        pageWidth: pdf?.originalPageWidth || 1000,
        pageHeight: pdf?.originalPageHeight || 1000,
      });
    },

    navigateToPage: (page, bounds) => {
      if (options.navigateToPage) {
        options.navigateToPage(page, bounds);
        return;
      }
      const canvas = useCanvasStore.getState();
      canvas.setCurrentPage(page);
      if (bounds && canvas.activeDocId) {
        canvas.setAiSelectionRect(canvas.activeDocId, page, bounds);
      }
    },

    activateEditorTool: tool => {
      // Single gate: mid-gesture reject + setActiveTool live in activateEditorToolOnCanvas.
      const result = activateEditorToolOnCanvas(tool);
      if (result.activated) {
        options.activateEditorTool?.(tool);
      }
      return result;
    },

    placeMarkups: payload => options.placeMarkups(payload),
    updateMarkups: payload => executeUpdateMarkups(payload),
    deleteMarkups: payload => executeDeleteMarkups(payload),
    linkCatalog: payload => executeLinkCatalog(payload),

    applyMaterialCountAdjustments: payload => {
      const adjustments = Array.isArray(payload)
        ? payload
        : (payload as { adjustments?: Array<{ markupId: string; value: number }> })?.adjustments || [];
      const store = useProductStore.getState();
      for (const item of adjustments) {
        if (item?.markupId != null && typeof item.value === 'number') {
          store.updateMeasurementValueByMarkupId(item.markupId, item.value);
        }
      }
      return { applied: adjustments.length };
    },

    saveProjectDraft: options.saveProjectDraft,
    confirmProjectSaved: () => options.lastSaveStatus?.() ?? { saved: false, reason: 'No save status tracked yet.' },
  };
}

function markupsToDetectedItems(markups: CanvasMarkup[], trade: TradeType): DetectedItem[] {
  return markups
    .filter(m => m.type === 'count-marker' || m.type === 'callout')
    .slice(0, 80)
    .map((m, index) => {
      const x = 'x' in m ? Number((m as { x?: number }).x) || 0 : 0;
      const y = 'y' in m ? Number((m as { y?: number }).y) || 0 : 0;
      return {
        id: m.id || `item_${index}`,
        type: m.label || m.type,
        trade,
        name: m.label || m.type,
        quantity: 1,
        location: { x, y, width: 20, height: 20 },
        confidence: 0.7,
      };
    });
}

export { searchTextItemsWithBounds } from './searchTextItems';
