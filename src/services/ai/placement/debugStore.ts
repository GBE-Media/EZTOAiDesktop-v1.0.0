import { create } from 'zustand';
import type { DocRect, GeometryAnchor, MarkupProposal, PageGeometry } from './types';

export interface PlacementDebugState {
  enabled: boolean;
  page: PageGeometry | null;
  ocrRects: DocRect[];
  anchors: GeometryAnchor[];
  proposals: MarkupProposal[];
  setEnabled: (enabled: boolean) => void;
  setDebugScene: (scene: {
    page: PageGeometry;
    ocrRects?: DocRect[];
    anchors?: GeometryAnchor[];
    proposals?: MarkupProposal[];
  }) => void;
  clear: () => void;
}

/**
 * Pure page-atomic scene merge for tests and the zustand store.
 * When the page number changes, omitted per-page arrays clear instead of
 * retaining the previous page's OCR/anchors/proposals.
 */
export function applyDebugSceneUpdate(scene: {
  page: PageGeometry;
  ocrRects?: DocRect[];
  anchors?: GeometryAnchor[];
  proposals?: MarkupProposal[];
}, state: {
  page: PageGeometry | null;
  ocrRects: DocRect[];
  anchors: GeometryAnchor[];
  proposals: MarkupProposal[];
}): {
  page: PageGeometry;
  ocrRects: DocRect[];
  anchors: GeometryAnchor[];
  proposals: MarkupProposal[];
} {
  const pageChanged = !state.page || state.page.pageNumber !== scene.page.pageNumber;

  return {
    page: scene.page,
    ocrRects: scene.ocrRects !== undefined
      ? scene.ocrRects
      : pageChanged
        ? []
        : state.ocrRects,
    anchors: scene.anchors !== undefined
      ? scene.anchors
      : pageChanged
        ? []
        : state.anchors,
    proposals: scene.proposals !== undefined
      ? scene.proposals
      : pageChanged
        ? []
        : state.proposals.filter(proposal => proposal.pageNumber === scene.page.pageNumber),
  };
}

export const usePlacementDebugStore = create<PlacementDebugState>((set) => ({
  enabled: false,
  page: null,
  ocrRects: [],
  anchors: [],
  proposals: [],
  setEnabled: (enabled) => set((state) => (state.enabled === enabled ? state : { enabled })),
  setDebugScene: (scene) => set((state) => applyDebugSceneUpdate(scene, state)),
  clear: () => set({
    page: null,
    ocrRects: [],
    anchors: [],
    proposals: [],
  }),
}));
