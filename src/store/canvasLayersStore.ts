/**
 * Canvas analysis-layer visibility.
 * Confirmed markups and selection stay in their own render path; this store
 * only gates OCR / anchors / proposals / symbols overlays and Review mode.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { usePlacementDebugStore } from '@/services/ai/placement/debugStore';

export interface CanvasLayerVisibility {
  ocr: boolean;
  anchors: boolean;
  proposals: boolean;
  symbols: boolean;
}

const HIDDEN_LAYERS: CanvasLayerVisibility = {
  ocr: false,
  anchors: false,
  proposals: false,
  symbols: false,
};

const REVIEW_LAYERS: CanvasLayerVisibility = {
  ocr: true,
  anchors: true,
  proposals: true,
  symbols: false,
};

interface CanvasLayersState {
  reviewAnalysisMode: boolean;
  layers: CanvasLayerVisibility;
  /** Snapshot restored when leaving review mode. */
  layersBeforeReview: CanvasLayerVisibility | null;

  setLayer: (layer: keyof CanvasLayerVisibility, visible: boolean) => void;
  setReviewAnalysisMode: (enabled: boolean) => void;
  /** True when any analysis overlay may paint. */
  anyAnalysisLayerVisible: () => boolean;
  /** True when scene data should be populated for the current page. */
  shouldPopulateAnalysisScene: () => boolean;
}

function syncLegacyPlacementDebug(enabled: boolean) {
  usePlacementDebugStore.getState().setEnabled(enabled);
}

export const useCanvasLayersStore = create<CanvasLayersState>()(
  persist(
    (set, get) => ({
      reviewAnalysisMode: false,
      layers: { ...HIDDEN_LAYERS },
      layersBeforeReview: null,

      setLayer: (layer, visible) => {
        set(state => {
          const layers = { ...state.layers, [layer]: visible };
          const anyVisible = layers.ocr || layers.anchors || layers.proposals || layers.symbols;
          syncLegacyPlacementDebug(state.reviewAnalysisMode || anyVisible);
          return { layers };
        });
      },

      setReviewAnalysisMode: (enabled) => {
        set(state => {
          if (enabled) {
            syncLegacyPlacementDebug(true);
            return {
              reviewAnalysisMode: true,
              layersBeforeReview: { ...state.layers },
              layers: {
                ...state.layers,
                ocr: true,
                anchors: true,
                proposals: true,
              },
            };
          }

          const restored = state.layersBeforeReview
            ? { ...state.layersBeforeReview }
            : { ...HIDDEN_LAYERS };
          const anyVisible = restored.ocr || restored.anchors || restored.proposals || restored.symbols;
          syncLegacyPlacementDebug(anyVisible);
          return {
            reviewAnalysisMode: false,
            layers: restored,
            layersBeforeReview: null,
          };
        });
        // Keep deprecated aiSettings flag in sync without calling setShowPlacementDebug (avoids loop).
        void import('@/store/aiSettingsStore').then(({ useAISettingsStore }) => {
          useAISettingsStore.setState({ showPlacementDebug: enabled });
        });
      },

      anyAnalysisLayerVisible: () => {
        const { layers, reviewAnalysisMode } = get();
        return (
          reviewAnalysisMode ||
          layers.ocr ||
          layers.anchors ||
          layers.proposals ||
          layers.symbols
        );
      },

      shouldPopulateAnalysisScene: () => get().anyAnalysisLayerVisible(),
    }),
    {
      name: 'canvas-layers-storage',
      partialize: (state) => ({
        reviewAnalysisMode: state.reviewAnalysisMode,
        layers: state.layers,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<CanvasLayersState> | undefined;
        const layers = {
          ...HIDDEN_LAYERS,
          ...(persisted?.layers ?? {}),
        };
        const reviewAnalysisMode = persisted?.reviewAnalysisMode ?? false;
        return {
          ...currentState,
          reviewAnalysisMode,
          layers: reviewAnalysisMode
            ? { ...layers, ocr: true, anchors: true, proposals: true }
            : layers,
          layersBeforeReview: null,
        };
      },
    }
  )
);

/** Compat helper for older call sites that toggled showPlacementDebug. */
export function setReviewAnalysisModeCompat(enabled: boolean) {
  useCanvasLayersStore.getState().setReviewAnalysisMode(enabled);
}
