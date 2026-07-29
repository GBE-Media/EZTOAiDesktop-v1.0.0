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

export const usePlacementDebugStore = create<PlacementDebugState>((set) => ({
  enabled: false,
  page: null,
  ocrRects: [],
  anchors: [],
  proposals: [],
  setEnabled: (enabled) => set((state) => (state.enabled === enabled ? state : { enabled })),
  setDebugScene: (scene) => set((state) => ({
    page: scene.page,
    ocrRects: scene.ocrRects ?? state.ocrRects,
    anchors: scene.anchors ?? state.anchors,
    // Preserve proposals for the page when refreshing OCR/layout on import/page change.
    proposals: scene.proposals !== undefined
      ? scene.proposals
      : state.proposals.filter(proposal => proposal.pageNumber === scene.page.pageNumber),
  })),
  clear: () => set({
    page: null,
    ocrRects: [],
    anchors: [],
    proposals: [],
  }),
}));
