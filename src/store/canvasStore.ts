import { create } from 'zustand';
import type { CanvasMarkup, Point, MarkupStyle, SelectionBox, SnapPoint } from '@/types/markup';
import type { ToolType } from '@/types/editor';
import { useHistoryStore } from './historyStore';
import { useEditorStore } from './editorStore';
import { useProductStore } from './productStore';
import type { TextItemWithBounds, TextWord } from '@/lib/pdfLoader';

const buildMeasurementFromMarkup = (markup: CanvasMarkup, documentId: string) => {
  if (!documentId) return null;

  if (markup.type === 'count-marker') {
    const countMarkup = markup as any;
    return {
      markupId: markup.id,
      documentId,
      page: markup.page,
      type: 'count',
      value: 1,
      unit: 'ea',
      groupId: countMarkup.groupId,
    };
  }

  if (markup.type === 'measurement-length' || markup.type === 'measurement-area') {
    const measurementMarkup = markup as any;
    return {
      markupId: markup.id,
      documentId,
      page: markup.page,
      type: markup.type === 'measurement-length' ? 'length' : 'area',
      value: measurementMarkup.scaledValue ?? measurementMarkup.value ?? 0,
      unit: measurementMarkup.unit || 'ft',
    };
  }

  return null;
};
import { extractVectorPaths, nearestPointOnLine, type DocumentSnapData, type DocumentLine } from '@/lib/pdfVectorExtractor';
interface CalibrationState {
  isCalibrating: boolean;
  point1: Point | null;
  point2: Point | null;
  knownDistance: number;
  unit: string;
}

interface DrawingState {
  isDrawing: boolean;
  currentPoints: Point[];
  previewMarkup: Partial<CanvasMarkup> | null;
}

interface DocumentPdfData {
  pdfDocument: any;
  totalPages: number;
  currentPage: number;
  zoom: number;
  markupsByPage: Record<number, CanvasMarkup[]>;
  originalPageWidth: number;
  originalPageHeight: number;
  panOffset: { x: number; y: number };
  hasViewState: boolean;
  originalPdfBytes: ArrayBuffer | null; // Store original PDF for saving
  textContentByPage: Record<number, TextItemWithBounds[]>; // Cached text for highlight snapping
  textWordsByPage: Record<number, TextWord[]>; // Word-level text for professional highlighting
  ocrStatus: 'none' | 'running' | 'completed' | 'failed';
  ocrProgress: number; // 0-100
}

interface CanvasState {
  // PDF state - now stores multiple documents
  pdfDocuments: Record<string, DocumentPdfData>;
  activeDocId: string | null;
  zoom: number;
  pageWidth: number;
  pageHeight: number;
  containerWidth: number;
  containerHeight: number;
  
  // Selected markups (global)
  selectedMarkupIds: string[];
  hoveredMarkupId: string | null;
  
  // Drawing state
  drawing: DrawingState;
  
  // Calibration
  calibration: CalibrationState;
  scale: number; // pixels per unit
  scaleUnit: string;
  
  // Grid and snap
  gridSize: number;
  snapToGrid: boolean;
  snapToObjects: boolean;
  snapPoints: SnapPoint[];
  
  // Document content snap data (per document, per page)
  documentSnapDataByPage: Record<string, Record<number, DocumentSnapData>>;
  documentSnapExtracting: boolean;
  activeSnapPoint: SnapPoint | null; // Currently active snap point for visual feedback
  
  // Default style
  defaultStyle: MarkupStyle;

  // AI selection/viewport capture
  aiSelectionActive: boolean;
  aiSelectionRect: { docId: string; page: number; rect: { x: number; y: number; width: number; height: number } } | null;
  aiViewportRect: { docId: string; page: number; rect: { x: number; y: number; width: number; height: number } } | null;

  // AI symbol calibration
  aiCalibrationActive: boolean;
  aiCalibrationType: string | null;
  aiCalibrationSamples: Record<string, Record<number, Record<string, { x: number; y: number }[]>>>;
  aiSymbolMap: Record<string, Record<number, Record<string, { x: number; y: number }[]>>>;
  aiSymbolDetectionRequested: boolean;
}

interface CanvasActions {
  // PDF actions
  setPdfDocument: (docId: string, doc: any, totalPages: number, originalWidth: number, originalHeight: number, originalBytes?: ArrayBuffer) => void;
  updatePdfDocument: (docId: string, doc: any, totalPages: number, originalWidth: number, originalHeight: number, originalBytes: ArrayBuffer) => void;
  setActiveDocId: (docId: string | null) => void;
  setCurrentPage: (page: number) => void;
  setZoom: (zoom: number) => void;
  setPageDimensions: (width: number, height: number) => void;
  removeDocument: (docId: string) => void;
  clearAllDocuments: () => void;
  fitToCanvas: (containerWidth: number, containerHeight: number) => void;
  setContainerDimensions: (width: number, height: number) => void;
  setPanOffset: (x: number, y: number) => void;
  resetPanOffset: () => void;
  
  // Helper selectors (use these functions instead of getters)
  getPanOffset: () => { x: number; y: number };
  getPdfDocument: () => any | null;
  getCurrentPage: () => number;
  getTotalPages: () => number;
  getMarkupsByPage: (docId?: string) => Record<number, CanvasMarkup[]>;
  getOriginalPdfBytes: (docId?: string) => ArrayBuffer | null;
  getTextContent: (page: number) => TextItemWithBounds[];
  setTextContent: (page: number, items: TextItemWithBounds[]) => void;
  getTextWords: (page: number) => TextWord[];
  setTextWords: (page: number, words: TextWord[]) => void;
  getOcrStatus: () => { status: 'none' | 'running' | 'completed' | 'failed'; progress: number };
  setOcrStatus: (status: 'none' | 'running' | 'completed' | 'failed', progress?: number) => void;
  
  // Markup actions
  addMarkup: (page: number, markup: CanvasMarkup) => void;
  updateMarkup: (page: number, id: string, updates: Partial<CanvasMarkup>) => void;
  deleteMarkups: (page: number, ids: string[]) => void;
  deleteMarkupFromDocument: (docId: string, page: number, markupId: string) => void; // Cross-document deletion
  selectMarkup: (id: string, addToSelection?: boolean) => void;
  clearSelection: () => void;
  setHoveredMarkup: (id: string | null) => void;
  
  // Drawing actions
  startDrawing: (point: Point) => void;
  updateDrawing: (point: Point) => void;
  finishDrawing: () => void;
  cancelDrawing: () => void;
  setPreviewMarkup: (markup: Partial<CanvasMarkup> | null) => void;
  
  // Calibration actions
  startCalibration: () => void;
  setCalibrationPoint: (point: Point, isFirst: boolean) => void;
  completeCalibration: (knownDistance: number, unit: string) => void;
  cancelCalibration: () => void;
  
  // Grid/snap actions
  setGridSize: (size: number) => void;
  toggleSnapToGrid: () => void;
  toggleSnapToObjects: () => void;
  updateSnapPoints: (markups: CanvasMarkup[]) => void;
  
  // Document content snap actions
  extractDocumentSnapData: (page: number) => Promise<void>;
  clearDocumentSnapData: () => void;
  getDocumentSnapData: (page: number) => DocumentSnapData | null;
  getSnapPointForPage: (page: number, point: Point, snapDistance?: number) => { point: Point; snapPoint: SnapPoint | null };
  setActiveSnapPoint: (point: SnapPoint | null) => void;
  
  // Style actions
  setDefaultStyle: (style: Partial<MarkupStyle>) => void;
  
  // AI markup actions
  addAIMarkup: (page: number, markup: CanvasMarkup, pending?: boolean) => void;
  addAIMarkupBatch: (markups: Array<{ page: number; markup: CanvasMarkup }>, pending?: boolean) => void;
  confirmAIMarkup: (page: number, id: string) => void;
  confirmAllAIMarkups: () => void;
  rejectAIMarkup: (page: number, id: string) => void;
  rejectAllAIMarkups: () => void;
  getAIPendingMarkups: () => Array<{ page: number; markup: CanvasMarkup }>;
  
  // Utility
  getSnapPoint: (point: Point) => { point: Point; snapPoint: SnapPoint | null };

  // AI selection/viewport actions
  setAiSelectionActive: (active: boolean) => void;
  setAiSelectionRect: (docId: string, page: number, rect: { x: number; y: number; width: number; height: number }) => void;
  clearAiSelection: () => void;
  setAiViewportRect: (docId: string, page: number, rect: { x: number; y: number; width: number; height: number }) => void;
  clearAiViewport: () => void;
  getAiSelectionForPage: (docId: string, page: number) => { x: number; y: number; width: number; height: number } | null;
  getAiViewportForPage: (docId: string, page: number) => { x: number; y: number; width: number; height: number } | null;

  // AI symbol calibration actions
  setAiCalibrationActive: (active: boolean) => void;
  setAiCalibrationType: (type: string | null) => void;
  addAiCalibrationSample: (docId: string, page: number, type: string, point: { x: number; y: number }) => void;
  clearAiCalibrationSamples: (docId: string, page: number, type?: string) => void;
  setAiSymbolMap: (docId: string, page: number, type: string, points: { x: number; y: number }[]) => void;
  getAiSymbolMapForPage: (docId: string, page: number) => Record<string, { x: number; y: number }[]>;
  requestAiSymbolDetection: () => void;
  clearAiSymbolDetectionRequest: () => void;
  
  // History actions
  undo: () => void;
  redo: () => void;
  setMarkupsForPage: (page: number, markups: CanvasMarkup[]) => void;
}

const initialState: CanvasState = {
  pdfDocuments: {},
  activeDocId: null,
  zoom: 100,
  pageWidth: 0,
  pageHeight: 0,
  containerWidth: 0,
  containerHeight: 0,
  
  selectedMarkupIds: [],
  hoveredMarkupId: null,
  
  drawing: {
    isDrawing: false,
    currentPoints: [],
    previewMarkup: null,
  },
  
  calibration: {
    isCalibrating: false,
    point1: null,
    point2: null,
    knownDistance: 0,
    unit: 'ft',
  },
  scale: 1,
  scaleUnit: 'ft',
  
  gridSize: 20,
  snapToGrid: false,
  snapToObjects: false,
  snapPoints: [],
  
  // Document content snap
  documentSnapDataByPage: {},
  documentSnapExtracting: false,
  activeSnapPoint: null,
  
  defaultStyle: {
    strokeColor: '#ef4444',
    fillColor: 'transparent',
    strokeWidth: 2,
    opacity: 100,
    fontSize: 12,
    fontFamily: 'Arial',
  },

  // AI selection/viewport capture
  aiSelectionActive: false,
  aiSelectionRect: null,
  aiViewportRect: null,

  // AI symbol calibration
  aiCalibrationActive: false,
  aiCalibrationType: null,
  aiCalibrationSamples: {},
  aiSymbolMap: {},
  aiSymbolDetectionRequested: false,
};

// Helper to get current document data
const getCurrentDocData = (state: CanvasState): DocumentPdfData | null => {
  if (!state.activeDocId) return null;
  return state.pdfDocuments[state.activeDocId] || null;
};

export const useCanvasStore = create<CanvasState & CanvasActions>((set, get) => ({
  ...initialState,
  
  // Helper selectors (functions, not getters - avoids Zustand merge issues)
  getPdfDocument: () => {
    const docData = getCurrentDocData(get());
    return docData?.pdfDocument || null;
  },
  
  getCurrentPage: () => {
    const docData = getCurrentDocData(get());
    return docData?.currentPage || 1;
  },
  
  getTotalPages: () => {
    const docData = getCurrentDocData(get());
    return docData?.totalPages || 0;
  },
  
  getMarkupsByPage: (docId?: string) => {
    const state = get();
    const targetId = docId || state.activeDocId;
    if (!targetId) return {};
    const docData = state.pdfDocuments[targetId];
    return docData?.markupsByPage || {};
  },
  
  getPanOffset: () => {
    const docData = getCurrentDocData(get());
    return docData?.panOffset || { x: 0, y: 0 };
  },
  
  getOriginalPdfBytes: (docId?: string) => {
    const state = get();
    const targetId = docId || state.activeDocId;
    if (!targetId) return null;
    const docData = state.pdfDocuments[targetId];
    return docData?.originalPdfBytes || null;
  },
  
  getTextContent: (page: number) => {
    const docData = getCurrentDocData(get());
    return docData?.textContentByPage[page] || [];
  },
  
  setTextContent: (page, items) => set((state) => {
    if (!state.activeDocId) return state;
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return state;
    return {
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          textContentByPage: {
            ...docData.textContentByPage,
            [page]: items,
          },
        },
      },
    };
  }),
  
  getTextWords: (page: number) => {
    const docData = getCurrentDocData(get());
    return docData?.textWordsByPage[page] || [];
  },
  
  setTextWords: (page, words) => set((state) => {
    if (!state.activeDocId) return state;
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return state;
    return {
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          textWordsByPage: {
            ...docData.textWordsByPage,
            [page]: words,
          },
        },
      },
    };
  }),
  
  getOcrStatus: () => {
    const docData = getCurrentDocData(get());
    return {
      status: docData?.ocrStatus || 'none',
      progress: docData?.ocrProgress || 0,
    };
  },
  
  setOcrStatus: (status, progress = 0) => set((state) => {
    if (!state.activeDocId) return state;
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return state;
    return {
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          ocrStatus: status,
          ocrProgress: progress,
        },
      },
    };
  }),
  
  setPdfDocument: (docId, doc, totalPages, originalWidth, originalHeight, originalBytes) => set((state) => ({
    pdfDocuments: {
      ...state.pdfDocuments,
      [docId]: {
        pdfDocument: doc,
        totalPages,
        currentPage: 1,
        zoom: 100,
        markupsByPage: {},
        originalPageWidth: originalWidth,
        originalPageHeight: originalHeight,
        panOffset: { x: 0, y: 0 },
        hasViewState: false,
        originalPdfBytes: originalBytes || null,
        textContentByPage: {},
        textWordsByPage: {},
        ocrStatus: 'none',
        ocrProgress: 0,
      },
    },
    activeDocId: docId,
    zoom: 100,
  })),
  
  // Update PDF document while preserving existing markups
  updatePdfDocument: (docId, doc, totalPages, originalWidth, originalHeight, originalBytes) => set((state) => {
    const existingDocData = state.pdfDocuments[docId];
    return {
      pdfDocuments: {
        ...state.pdfDocuments,
        [docId]: {
          pdfDocument: doc,
          totalPages,
          currentPage: Math.min(existingDocData?.currentPage || 1, totalPages),
          zoom: existingDocData?.zoom ?? state.zoom,
          markupsByPage: existingDocData?.markupsByPage || {},  // PRESERVE existing markups
          originalPageWidth: originalWidth,
          originalPageHeight: originalHeight,
          panOffset: existingDocData?.panOffset || { x: 0, y: 0 },
          hasViewState: existingDocData?.hasViewState ?? false,
          originalPdfBytes: originalBytes,
          textContentByPage: {},  // Clear text cache (page structure changed)
          textWordsByPage: {},
          ocrStatus: 'none',
          ocrProgress: 0,
        },
      },
    };
  }),
  
  setActiveDocId: (docId) => set((state) => {
    const docData = docId ? state.pdfDocuments[docId] : null;
    return {
      activeDocId: docId,
      zoom: docData?.zoom ?? state.zoom,
    };
  }),
  
  removeDocument: (docId) => set((state) => {
    const { [docId]: removed, ...rest } = state.pdfDocuments;
    return { 
      pdfDocuments: rest,
      activeDocId: state.activeDocId === docId ? null : state.activeDocId,
    };
  }),
  
  clearAllDocuments: () => set({
    pdfDocuments: {},
    activeDocId: null,
  }),
  
  setCurrentPage: (page) => set((state) => {
    if (!state.activeDocId) return state;
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return state;

    useEditorStore.getState().updateDocument(state.activeDocId, { currentPage: page });

    return {
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: { ...docData, currentPage: page, hasViewState: true },
      },
    };
  }),
  
  setZoom: (zoom) => set((state) => {
    if (!state.activeDocId) return { zoom };
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return { zoom };

    useEditorStore.getState().updateDocument(state.activeDocId, { zoom });

    return {
      zoom,
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: { ...docData, zoom, hasViewState: true },
      },
    };
  }),
  
  setPageDimensions: (width, height) => set({ pageWidth: width, pageHeight: height }),
  
  setContainerDimensions: (width, height) => set({ containerWidth: width, containerHeight: height }),
  
  fitToCanvas: (containerWidth, containerHeight) => {
    const state = get();
    const docData = getCurrentDocData(state);
    if (!docData) return;
    
    const { originalPageWidth, originalPageHeight } = docData;
    if (!originalPageWidth || !originalPageHeight) return;
    
    // Account for padding (64px on each side = 128px total)
    const padding = 128;
    const availableWidth = containerWidth - padding;
    const availableHeight = containerHeight - padding;
    
    // Calculate zoom to fit both dimensions
    const scaleX = availableWidth / (originalPageWidth * 1.5); // Account for base scale of 1.5
    const scaleY = availableHeight / (originalPageHeight * 1.5);
    const fitScale = Math.min(scaleX, scaleY);
    
    // Convert to percentage and clamp between 25-400%
    const newZoom = Math.max(25, Math.min(400, Math.round(fitScale * 100)));
    
    console.log('[FIT-TO-CANVAS] Container:', containerWidth, 'x', containerHeight);
    console.log('[FIT-TO-CANVAS] Available:', availableWidth, 'x', availableHeight);
    console.log('[FIT-TO-CANVAS] Page:', originalPageWidth, 'x', originalPageHeight);
    console.log('[FIT-TO-CANVAS] Zoom:', newZoom + '%');
    
    set((currentState) => ({
      zoom: newZoom,
      pdfDocuments: {
        ...currentState.pdfDocuments,
        [currentState.activeDocId as string]: {
          ...currentState.pdfDocuments[currentState.activeDocId as string],
          zoom: newZoom,
          panOffset: { x: 0, y: 0 },
          hasViewState: true,
        },
      },
    }));
  },
  
  setPanOffset: (x, y) => set((state) => {
    if (!state.activeDocId) return state;
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return state;
    return {
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: { ...docData, panOffset: { x, y }, hasViewState: true },
      },
    };
  }),
  
  resetPanOffset: () => set((state) => {
    if (!state.activeDocId) return state;
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return state;
    return {
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: { ...docData, panOffset: { x: 0, y: 0 } },
      },
    };
  }),
  addMarkup: (page, markup) => {
    const state = get();
    if (!state.activeDocId) return;
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return;
    
    const beforeMarkups = [...(docData.markupsByPage[page] || [])];
    const afterMarkups = [...beforeMarkups, markup];
    
    // Push to history
    useHistoryStore.getState().pushHistory({
      action: 'add',
      page,
      before: beforeMarkups,
      after: afterMarkups,
      description: `Added ${markup.type}`,
    });
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          markupsByPage: {
            ...docData.markupsByPage,
            [page]: afterMarkups,
          },
        },
      },
    });
    
    // Mark document as modified in editorStore
    useEditorStore.getState().updateDocument(state.activeDocId, { modified: true });
  },
  
  updateMarkup: (page, id, updates) => {
    const state = get();
    if (!state.activeDocId) return;
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return;
    
    const pageMarkups = docData.markupsByPage[page] || [];
    const beforeMarkups = [...pageMarkups];
    const afterMarkups = pageMarkups.map((m) =>
      m.id === id ? { ...m, ...updates } as CanvasMarkup : m
    );
    
    // Push to history
    useHistoryStore.getState().pushHistory({
      action: 'update',
      page,
      before: beforeMarkups,
      after: afterMarkups,
      description: `Updated markup`,
    });
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          markupsByPage: {
            ...docData.markupsByPage,
            [page]: afterMarkups,
          },
        },
      },
    });
    
    // Mark document as modified in editorStore
    useEditorStore.getState().updateDocument(state.activeDocId, { modified: true });
  },
  
  deleteMarkups: (page, ids) => {
    const state = get();
    if (!state.activeDocId) return;
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return;
    
    const beforeMarkups = [...(docData.markupsByPage[page] || [])];
    const deletedMarkups = beforeMarkups.filter((m) => ids.includes(m.id));
    const afterMarkups = beforeMarkups.filter((m) => !ids.includes(m.id));

    // Capture linked measurements before unlinking for undo/redo
    const productStore = useProductStore.getState();
    const linkedMeasurements = deletedMarkups.flatMap((markup) => {
      const link = productStore.getMeasurementByMarkupId(markup.id);
      if (!link) return [];
      const { productId, measurement } = link;
      const { id, createdAt, ...rest } = measurement;
      return [{ productId, measurement: rest }];
    });
    
    // Push to history
    useHistoryStore.getState().pushHistory({
      action: 'delete',
      page,
      before: beforeMarkups,
      after: afterMarkups,
      description: `Deleted ${ids.length} markup(s)`,
      linkedMeasurements: linkedMeasurements.length > 0 ? linkedMeasurements : undefined,
    });
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          markupsByPage: {
            ...docData.markupsByPage,
            [page]: afterMarkups,
          },
        },
      },
      selectedMarkupIds: state.selectedMarkupIds.filter((id) => !ids.includes(id)),
    });
    
    // Mark document as modified in editorStore
    useEditorStore.getState().updateDocument(state.activeDocId, { modified: true });
    
    // Cascade: unlink deleted markups from product store
    deletedMarkups.forEach((markup) => {
      productStore.unlinkMeasurementByMarkupId(markup.id);
    });
  },
  
  deleteMarkupFromDocument: (docId, page, markupId) => {
    const state = get();
    const docData = state.pdfDocuments[docId];
    if (!docData) return;
    
    const beforeMarkups = [...(docData.markupsByPage[page] || [])];
    const deletedMarkup = beforeMarkups.find((m) => m.id === markupId);
    const afterMarkups = beforeMarkups.filter((m) => m.id !== markupId);
    
    if (!deletedMarkup) return;

    // Capture linked measurement for undo/redo
    const productStore = useProductStore.getState();
    const linkedMeasurements = (() => {
      const link = productStore.getMeasurementByMarkupId(markupId);
      if (!link) return undefined;
      const { productId, measurement } = link;
      const { id, createdAt, ...rest } = measurement;
      return [{ productId, measurement: rest }];
    })();
    
    // Push to history
    useHistoryStore.getState().pushHistory({
      action: 'delete',
      page,
      before: beforeMarkups,
      after: afterMarkups,
      description: `Deleted markup`,
      linkedMeasurements,
    });
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [docId]: {
          ...docData,
          markupsByPage: {
            ...docData.markupsByPage,
            [page]: afterMarkups,
          },
        },
      },
      selectedMarkupIds: state.selectedMarkupIds.filter((id) => id !== markupId),
    });
    
    // Mark document as modified in editorStore
    useEditorStore.getState().updateDocument(docId, { modified: true });
    
    // Unlink from product store
    productStore.unlinkMeasurementByMarkupId(markupId);
  },
  
  selectMarkup: (id, addToSelection = false) => set((state) => ({
    selectedMarkupIds: addToSelection
      ? state.selectedMarkupIds.includes(id)
        ? state.selectedMarkupIds.filter((i) => i !== id)
        : [...state.selectedMarkupIds, id]
      : [id],
  })),
  
  clearSelection: () => set({ selectedMarkupIds: [] }),
  
  setHoveredMarkup: (id) => set({ hoveredMarkupId: id }),
  
  startDrawing: (point) => set((state) => ({
    drawing: {
      isDrawing: true,
      currentPoints: [point],
      previewMarkup: null,
    },
  })),
  
  updateDrawing: (point) => set((state) => ({
    drawing: {
      ...state.drawing,
      currentPoints: [...state.drawing.currentPoints, point],
    },
  })),
  
  finishDrawing: () => set((state) => ({
    drawing: {
      isDrawing: false,
      currentPoints: [],
      previewMarkup: null,
    },
  })),
  
  cancelDrawing: () => set({
    drawing: {
      isDrawing: false,
      currentPoints: [],
      previewMarkup: null,
    },
  }),
  
  setPreviewMarkup: (markup) => set((state) => ({
    drawing: {
      ...state.drawing,
      previewMarkup: markup,
    },
  })),
  
  startCalibration: () => set((state) => ({
    calibration: {
      ...state.calibration,
      isCalibrating: true,
      point1: null,
      point2: null,
    },
  })),
  
  setCalibrationPoint: (point, isFirst) => set((state) => ({
    calibration: {
      ...state.calibration,
      [isFirst ? 'point1' : 'point2']: point,
    },
  })),
  
  completeCalibration: (knownDistance, unit) => {
    const state = get();
    const { point1, point2 } = state.calibration;
    
    if (!point1 || !point2) return;
    
    const pixelDistance = Math.sqrt(
      Math.pow(point2.x - point1.x, 2) + Math.pow(point2.y - point1.y, 2)
    );
    
    const scale = pixelDistance / knownDistance;
    
    set({
      scale,
      scaleUnit: unit,
      calibration: {
        isCalibrating: false,
        point1: null,
        point2: null,
        knownDistance,
        unit,
      },
    });
  },
  
  cancelCalibration: () => set((state) => ({
    calibration: {
      ...state.calibration,
      isCalibrating: false,
      point1: null,
      point2: null,
    },
  })),
  
  setGridSize: (size) => set({ gridSize: size }),
  
  toggleSnapToGrid: () => set((state) => ({ snapToGrid: !state.snapToGrid })),
  
  toggleSnapToObjects: () => set((state) => ({ snapToObjects: !state.snapToObjects })),
  
  updateSnapPoints: (markups) => {
    const snapPoints: SnapPoint[] = [];
    
    markups.forEach((markup) => {
      if ('x' in markup && 'width' in markup) {
        const m = markup as any;
        // Corners
        snapPoints.push({ x: m.x, y: m.y, type: 'corner' });
        snapPoints.push({ x: m.x + m.width, y: m.y, type: 'corner' });
        snapPoints.push({ x: m.x, y: m.y + m.height, type: 'corner' });
        snapPoints.push({ x: m.x + m.width, y: m.y + m.height, type: 'corner' });
        // Center
        snapPoints.push({ x: m.x + m.width / 2, y: m.y + m.height / 2, type: 'center' });
        // Midpoints
        snapPoints.push({ x: m.x + m.width / 2, y: m.y, type: 'midpoint' });
        snapPoints.push({ x: m.x + m.width / 2, y: m.y + m.height, type: 'midpoint' });
        snapPoints.push({ x: m.x, y: m.y + m.height / 2, type: 'midpoint' });
        snapPoints.push({ x: m.x + m.width, y: m.y + m.height / 2, type: 'midpoint' });
      }
      
      if ('startX' in markup) {
        const m = markup as any;
        snapPoints.push({ x: m.startX, y: m.startY, type: 'endpoint' });
        snapPoints.push({ x: m.endX, y: m.endY, type: 'endpoint' });
      }
      
      if ('points' in markup) {
        const m = markup as any;
        m.points.forEach((p: Point) => {
          snapPoints.push({ x: p.x, y: p.y, type: 'endpoint' });
        });
      }
    });
    
    set({ snapPoints });
  },
  
  // Document content snap actions
  extractDocumentSnapData: async (page) => {
    const state = get();
    if (!state.activeDocId || state.documentSnapExtracting) return;
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData?.pdfDocument) return;
    
    // Check if already extracted for this page
    const existingData = state.documentSnapDataByPage[state.activeDocId]?.[page];
    if (existingData) return;
    
    set({ documentSnapExtracting: true });
    
    try {
      const snapData = await extractVectorPaths(docData.pdfDocument, page);
      
      set((prevState) => ({
        documentSnapExtracting: false,
        documentSnapDataByPage: {
          ...prevState.documentSnapDataByPage,
          [state.activeDocId!]: {
            ...(prevState.documentSnapDataByPage[state.activeDocId!] || {}),
            [page]: snapData,
          },
        },
      }));
      
      console.log(`Extracted ${snapData.lines.length} lines, ${snapData.endpoints.length} endpoints, ${snapData.intersections.length} intersections for page ${page}`);
    } catch (error) {
      console.error('Failed to extract document snap data:', error);
      set({ documentSnapExtracting: false });
    }
  },
  
  clearDocumentSnapData: () => set({ documentSnapDataByPage: {} }),
  
  getDocumentSnapData: (page) => {
    const state = get();
    if (!state.activeDocId) return null;
    return state.documentSnapDataByPage[state.activeDocId]?.[page] || null;
  },

  getSnapPointForPage: (page, point, snapDistance = 10) => {
    const state = get();
    if (!state.activeDocId) return { point, snapPoint: null };
    const docSnapData = state.documentSnapDataByPage[state.activeDocId]?.[page];
    if (!docSnapData) return { point, snapPoint: null };

    const distance = (p1: Point, p2: Point) =>
      Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));

    for (const endpoint of docSnapData.endpoints) {
      if (distance(point, endpoint) < snapDistance) {
        return { point: endpoint, snapPoint: { x: endpoint.x, y: endpoint.y, type: 'document-endpoint' } };
      }
    }

    for (const intersection of docSnapData.intersections) {
      if (distance(point, intersection) < snapDistance) {
        return { point: intersection, snapPoint: { x: intersection.x, y: intersection.y, type: 'intersection' } };
      }
    }

    for (const line of docSnapData.lines) {
      const nearest = nearestPointOnLine(point, line);
      if (distance(point, nearest) < snapDistance) {
        return { point: nearest, snapPoint: { x: nearest.x, y: nearest.y, type: 'document-line' } };
      }
    }

    return { point, snapPoint: null };
  },
  
  setActiveSnapPoint: (point) => set({ activeSnapPoint: point }),
  
  setDefaultStyle: (style) => set((state) => ({
    defaultStyle: { ...state.defaultStyle, ...style },
  })),
  
  getSnapPoint: (point) => {
    const state = get();
    const snapDistance = 10;
    
    // Helper to calculate distance
    const distance = (p1: Point, p2: Point) => 
      Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
    
    // Check document content snap first (highest priority when enabled)
    if (state.snapToObjects && state.activeDocId) {
      const docData = getCurrentDocData(state);
      if (docData) {
        const docSnapData = state.documentSnapDataByPage[state.activeDocId]?.[docData.currentPage];
        
        if (docSnapData) {
          // 1. Check document endpoints (highest priority)
          for (const endpoint of docSnapData.endpoints) {
            if (distance(point, endpoint) < snapDistance) {
              const snapPoint: SnapPoint = { x: endpoint.x, y: endpoint.y, type: 'document-endpoint' };
              return { point: endpoint, snapPoint };
            }
          }
          
          // 2. Check document intersections
          for (const intersection of docSnapData.intersections) {
            if (distance(point, intersection) < snapDistance) {
              const snapPoint: SnapPoint = { x: intersection.x, y: intersection.y, type: 'intersection' };
              return { point: intersection, snapPoint };
            }
          }
          
          // 3. Check nearest point on document lines
          for (const line of docSnapData.lines) {
            const nearest = nearestPointOnLine(point, line);
            if (distance(point, nearest) < snapDistance) {
              const snapPoint: SnapPoint = { x: nearest.x, y: nearest.y, type: 'document-line' };
              return { point: nearest, snapPoint };
            }
          }
        }
      }
    }
    
    // Check markup object snap points
    if (state.snapToObjects) {
      for (const markupSnapPoint of state.snapPoints) {
        const dist = distance(point, markupSnapPoint);
        if (dist < snapDistance) {
          return { point: { x: markupSnapPoint.x, y: markupSnapPoint.y }, snapPoint: markupSnapPoint };
        }
      }
    }
    
    // Check grid snap last
    if (state.snapToGrid) {
      const snappedX = Math.round(point.x / state.gridSize) * state.gridSize;
      const snappedY = Math.round(point.y / state.gridSize) * state.gridSize;
      
      if (
        Math.abs(point.x - snappedX) < snapDistance &&
        Math.abs(point.y - snappedY) < snapDistance
      ) {
        const snapPoint: SnapPoint = { x: snappedX, y: snappedY, type: 'grid' };
        return { point: { x: snappedX, y: snappedY }, snapPoint };
      }
    }
    
    return { point, snapPoint: null };
  },

  // AI selection/viewport actions
  setAiSelectionActive: (active) => set({ aiSelectionActive: active }),

  setAiSelectionRect: (docId, page, rect) => set({
    aiSelectionRect: { docId, page, rect },
  }),

  clearAiSelection: () => set({ aiSelectionRect: null, aiSelectionActive: false }),

  setAiViewportRect: (docId, page, rect) => set({
    aiViewportRect: { docId, page, rect },
  }),

  clearAiViewport: () => set({ aiViewportRect: null }),

  getAiSelectionForPage: (docId, page) => {
    const state = get();
    if (!state.aiSelectionRect) return null;
    if (state.aiSelectionRect.docId !== docId || state.aiSelectionRect.page !== page) return null;
    return state.aiSelectionRect.rect;
  },

  getAiViewportForPage: (docId, page) => {
    const state = get();
    if (!state.aiViewportRect) return null;
    if (state.aiViewportRect.docId !== docId || state.aiViewportRect.page !== page) return null;
    return state.aiViewportRect.rect;
  },

  setAiCalibrationActive: (active) => set({ aiCalibrationActive: active }),

  setAiCalibrationType: (type) => set({ aiCalibrationType: type }),

  addAiCalibrationSample: (docId, page, type, point) => set((state) => {
    const docSamples = state.aiCalibrationSamples[docId] || {};
    const pageSamples = docSamples[page] || {};
    const typeSamples = pageSamples[type] || [];
    return {
      aiCalibrationSamples: {
        ...state.aiCalibrationSamples,
        [docId]: {
          ...docSamples,
          [page]: {
            ...pageSamples,
            [type]: [...typeSamples, point],
          },
        },
      },
    };
  }),

  clearAiCalibrationSamples: (docId, page, type) => set((state) => {
    const docSamples = state.aiCalibrationSamples[docId] || {};
    const pageSamples = docSamples[page] || {};
    if (!type) {
      return {
        aiCalibrationSamples: {
          ...state.aiCalibrationSamples,
          [docId]: {
            ...docSamples,
            [page]: {},
          },
        },
      };
    }
    const { [type]: _, ...restTypes } = pageSamples;
    return {
      aiCalibrationSamples: {
        ...state.aiCalibrationSamples,
        [docId]: {
          ...docSamples,
          [page]: restTypes,
        },
      },
    };
  }),

  setAiSymbolMap: (docId, page, type, points) => set((state) => {
    const docMap = state.aiSymbolMap[docId] || {};
    const pageMap = docMap[page] || {};
    return {
      aiSymbolMap: {
        ...state.aiSymbolMap,
        [docId]: {
          ...docMap,
          [page]: {
            ...pageMap,
            [type]: points,
          },
        },
      },
    };
  }),

  getAiSymbolMapForPage: (docId, page) => {
    const state = get();
    return state.aiSymbolMap[docId]?.[page] || {};
  },

  requestAiSymbolDetection: () => set({ aiSymbolDetectionRequested: true }),

  clearAiSymbolDetectionRequest: () => set({ aiSymbolDetectionRequested: false }),
  
  // Direct setter for undo/redo operations (bypasses history)
  setMarkupsForPage: (page, markups) => {
    const state = get();
    if (!state.activeDocId) return;
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return;
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          markupsByPage: {
            ...docData.markupsByPage,
            [page]: markups,
          },
        },
      },
    });
    
    // Mark document as modified in editorStore
    useEditorStore.getState().updateDocument(state.activeDocId, { modified: true });
  },
  
  // AI Markup Actions
  addAIMarkup: (page, markup, pending = true) => {
    const aiMarkup = {
      ...markup,
      aiGenerated: true,
      aiPending: pending,
    };
    get().addMarkup(page, aiMarkup);
  },
  
  addAIMarkupBatch: (markups, pending = true) => {
    const state = get();
    if (!state.activeDocId) return;
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return;
    
    // Group markups by page
    const markupsByPage = { ...docData.markupsByPage };
    
    for (const { page, markup } of markups) {
      const aiMarkup = {
        ...markup,
        aiGenerated: true,
        aiPending: pending,
      };
      
      if (!markupsByPage[page]) {
        markupsByPage[page] = [];
      }
      markupsByPage[page] = [...markupsByPage[page], aiMarkup];
    }
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          markupsByPage,
        },
      },
    });
    
    useEditorStore.getState().updateDocument(state.activeDocId, { modified: true });
  },
  
  confirmAIMarkup: (page, id) => {
    get().updateMarkup(page, id, { aiPending: false });
  },
  
  confirmAllAIMarkups: () => {
    const state = get();
    if (!state.activeDocId) return;
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return;
    
    const markupsByPage = { ...docData.markupsByPage };
    
    for (const pageNum of Object.keys(markupsByPage)) {
      const page = parseInt(pageNum);
      markupsByPage[page] = markupsByPage[page].map(markup => 
        markup.aiPending ? { ...markup, aiPending: false } : markup
      );
    }
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          markupsByPage,
        },
      },
    });
  },
  
  rejectAIMarkup: (page, id) => {
    get().deleteMarkups(page, [id]);
  },
  
  rejectAllAIMarkups: () => {
    const state = get();
    if (!state.activeDocId) return;
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return;
    
    const markupsByPage = { ...docData.markupsByPage };
    
    for (const pageNum of Object.keys(markupsByPage)) {
      const page = parseInt(pageNum);
      markupsByPage[page] = markupsByPage[page].filter(markup => !markup.aiPending);
    }
    
    set({
      pdfDocuments: {
        ...state.pdfDocuments,
        [state.activeDocId]: {
          ...docData,
          markupsByPage,
        },
      },
    });
  },
  
  getAIPendingMarkups: () => {
    const state = get();
    if (!state.activeDocId) return [];
    
    const docData = state.pdfDocuments[state.activeDocId];
    if (!docData) return [];
    
    const pending: Array<{ page: number; markup: CanvasMarkup }> = [];
    
    for (const [pageStr, markups] of Object.entries(docData.markupsByPage)) {
      const page = parseInt(pageStr);
      for (const markup of markups) {
        if (markup.aiPending) {
          pending.push({ page, markup });
        }
      }
    }
    
    return pending;
  },
  
  undo: () => {
    const historyEntry = useHistoryStore.getState().undo();
    if (!historyEntry || !historyEntry.before || !historyEntry.after) return;

    const state = get();
    const productStore = useProductStore.getState();

    const diffMarkups = (from, to) => {
      const toIds = new Set(to.map((m) => m.id));
      return from.filter((m) => !toIds.has(m.id));
    };

    const removed = diffMarkups(historyEntry.after, historyEntry.before);
    const added = diffMarkups(historyEntry.before, historyEntry.after);

    // Capture linked measurements for redo if missing
    if (!historyEntry.linkedMeasurements || historyEntry.linkedMeasurements.length === 0) {
      const captured = removed.flatMap((markup) => {
        const link = productStore.getMeasurementByMarkupId(markup.id);
        if (!link) return [];
        const { productId, measurement } = link;
        const { id, createdAt, ...rest } = measurement;
        return [{ productId, measurement: rest }];
      });
      if (captured.length > 0) {
        historyEntry.linkedMeasurements = captured;
      }
    }

    // Unlink measurements for removed markups
    removed.forEach((markup) => {
      productStore.unlinkMeasurementByMarkupId(markup.id);
    });

    // Restore previous markups
    get().setMarkupsForPage(historyEntry.page, historyEntry.before);

    // Relink measurements for added markups
    if (added.length > 0) {
      const linked = historyEntry.linkedMeasurements || [];
      if (linked.length > 0) {
        linked.forEach((entry) => {
          if (productStore.getMeasurementByMarkupId(entry.measurement.markupId)) return;
          productStore.linkMeasurement(entry.productId, entry.measurement);
        });
      } else {
        added.forEach((markup) => {
          const productId = (markup as any).productId;
          if (!productId || !state.activeDocId) return;
          const measurement = buildMeasurementFromMarkup(markup as any, state.activeDocId);
          if (measurement) {
            if (productStore.getMeasurementByMarkupId(measurement.markupId)) return;
            productStore.linkMeasurement(productId, measurement);
          }
        });
      }
    }
  },
  
  redo: () => {
    const historyEntry = useHistoryStore.getState().redo();
    if (!historyEntry || !historyEntry.before || !historyEntry.after) return;

    const state = get();
    const productStore = useProductStore.getState();

    const diffMarkups = (from, to) => {
      const toIds = new Set(to.map((m) => m.id));
      return from.filter((m) => !toIds.has(m.id));
    };

    const removed = diffMarkups(historyEntry.before, historyEntry.after);
    const added = diffMarkups(historyEntry.after, historyEntry.before);

    // Unlink measurements for removed markups
    removed.forEach((markup) => {
      productStore.unlinkMeasurementByMarkupId(markup.id);
    });

    // Apply next markups
    get().setMarkupsForPage(historyEntry.page, historyEntry.after);

    // Relink measurements for added markups
    if (added.length > 0) {
      const linked = historyEntry.linkedMeasurements || [];
      if (linked.length > 0) {
        linked.forEach((entry) => {
          if (productStore.getMeasurementByMarkupId(entry.measurement.markupId)) return;
          productStore.linkMeasurement(entry.productId, entry.measurement);
        });
      } else {
        added.forEach((markup) => {
          const productId = (markup as any).productId;
          if (!productId || !state.activeDocId) return;
          const measurement = buildMeasurementFromMarkup(markup as any, state.activeDocId);
          if (measurement) {
            if (productStore.getMeasurementByMarkupId(measurement.markupId)) return;
            productStore.linkMeasurement(productId, measurement);
          }
        });
      }
    }
  },
}));
