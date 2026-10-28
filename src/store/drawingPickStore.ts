import { create } from 'zustand';
import type { PickedArea, PickedPoint } from '@/types/assistant';

/** A question card asking the user to click a spot (or drag boxes) on the drawing. */
export interface DrawingPickRequest {
  /** clarificationId:fieldId */
  key: string;
  label: string;
  documentId?: string;
  page?: number;
  /** point: one click · area: drag a box (repeatable). */
  mode?: 'point' | 'area';
}

export function pickMatchesPage(request: DrawingPickRequest | null, documentId: string | null | undefined, page: number): boolean {
  return !!request && (!request.documentId || request.documentId === documentId)
    && (!request.page || request.page === page);
}

interface DrawingPickState {
  request: DrawingPickRequest | null;
  /** Pins already picked (shown on the drawing until the card is answered). */
  pins: Record<string, PickedPoint & { label: string }>;
  /** Boxes dragged for area questions, per key. */
  areas: Record<string, PickedArea[]>;
  start: (request: DrawingPickRequest) => void;
  complete: (point: PickedPoint) => void;
  /** Add to the originating, still-active area session. Ending a card cannot resurrect it. */
  addArea: (area: PickedArea, key?: string) => void;
  clearAreas: (key: string) => void;
  /** Seed AI-drafted boxes once (no-op if the user already has areas for this key). */
  seedAreas: (key: string, areas: PickedArea[]) => void;
  removeArea: (key: string, index: number) => void;
  cancel: () => void;
  clearPin: (key: string) => void;
  clearPins: (keyPrefix: string) => void;
}

export const useDrawingPickStore = create<DrawingPickState>((set, get) => ({
  request: null,
  pins: {},
  areas: {},
  start: request => set(state => ({
    request,
    // Redo starts a fresh point; a stale pin must not overwrite a new choice on the card.
    pins: request.mode === 'area' ? state.pins : Object.fromEntries(Object.entries(state.pins).filter(([key]) => key !== request.key)),
  })),
  complete: point => {
    const request = get().request;
    if (!request || !pickMatchesPage(request, point.documentId, point.page) || request.mode === 'area') return;
    set(state => ({
      request: null,
      pins: { ...state.pins, [request.key]: { ...point, label: request.label } },
    }));
  },
  addArea: (area, explicitKey) => {
    const request = get().request;
    const key = explicitKey || request?.key;
    if (!key || request?.key !== key || request.mode !== 'area'
      || !pickMatchesPage(request, area.documentId, area.page)) return;
    set(state => ({ areas: { ...state.areas, [key]: [...(state.areas[key] || []), area] } }));
  },
  // Keep the key (empty list) so AI-drafted boxes aren't re-seeded after the user clears them.
  clearAreas: key => set(state => ({ areas: { ...state.areas, [key]: [] } })),
  seedAreas: (key, seed) => set(state => (key in state.areas || !seed.length ? state : { areas: { ...state.areas, [key]: seed.map(a => ({ ...a })) } })),
  removeArea: (key, index) => set(state => ({
    areas: { ...state.areas, [key]: (state.areas[key] || []).filter((_, i) => i !== index) },
  })),
  cancel: () => set({ request: null }),
  clearPin: key => set(state => ({
    pins: Object.fromEntries(Object.entries(state.pins).filter(([k]) => k !== key)),
    request: state.request?.key === key ? null : state.request,
  })),
  clearPins: keyPrefix => set(state => ({
    pins: Object.fromEntries(Object.entries(state.pins).filter(([key]) => !key.startsWith(keyPrefix))),
    areas: Object.fromEntries(Object.entries(state.areas).filter(([key]) => !key.startsWith(keyPrefix))),
    request: state.request?.key.startsWith(keyPrefix) ? null : state.request,
  })),
}));
