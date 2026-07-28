import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { useProductStore } from '@/store/productStore';
import { summarizeCatalogForChat, summarizeMarkupsForChat } from '../contextSummary';
import { suggestLayoutsFromItems } from '../layouts';
import type { DetectedItem, TradeType } from '../providers/types';
import type { AssistantToolContext } from '../tools/types';
import type { CanvasMarkup } from '@/types/markup';
import { searchTextItemsWithBounds } from './searchTextItems';
import { BASE_RENDER_SCALE } from '../placement/coords';

export interface CreateAgentToolContextOptions {
  runId: string;
  messageId: string;
  signal?: AbortSignal;
  trade: TradeType;
  placeMarkups: (payload: unknown) => Promise<unknown> | unknown;
  saveProjectDraft?: () => Promise<{ saved: boolean; path?: string | null; reason?: string }>;
  lastSaveStatus?: () => { saved: boolean; path?: string | null; at?: string };
  analyzePage?: (input: unknown) => Promise<unknown>;
  searchDocument?: (query: string) => Promise<import('@/types/assistant').EvidenceCitation[]>;
  navigateToPage?: (page: number, bounds?: { x: number; y: number; width: number; height: number }) => void;
  activateEditorTool?: (tool: string) => void;
  projectPath?: string | null;
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

    analyzePage: options.analyzePage || (async input => ({
      status: 'unavailable',
      message: 'Full page analysis is available via the Takeoff pipeline. Pass analyzePage adapter for agent vision.',
      input,
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
      options.activateEditorTool?.(tool);
    },

    placeMarkups: payload => options.placeMarkups(payload),
    updateMarkups: () => ({ status: 'unsupported', message: 'update_markups executor not wired in v1' }),
    deleteMarkups: () => ({ status: 'unsupported', message: 'delete_markups executor not wired in v1' }),
    linkCatalog: () => ({ status: 'unsupported', message: 'link_catalog executor not wired in v1' }),

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
