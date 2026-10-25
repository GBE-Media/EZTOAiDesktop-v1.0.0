import { create } from 'zustand';
import type { PickedPoint } from '@/types/assistant';

/** A question card asking the user to click a spot on the drawing. */
export interface DrawingPickRequest {
  /** clarificationId:fieldId */
  key: string;
  label: string;
  documentId?: string;
  page?: number;
}

interface DrawingPickState {
  request: DrawingPickRequest | null;
  /** Pins already picked (shown on the drawing until the card is answered). */
  pins: Record<string, PickedPoint & { label: string }>;
  start: (request: DrawingPickRequest) => void;
  complete: (point: PickedPoint) => void;
  cancel: () => void;
  clearPins: (keyPrefix: string) => void;
}

export const useDrawingPickStore = create<DrawingPickState>((set, get) => ({
  request: null,
  pins: {},
  start: request => set({ request }),
  complete: point => {
    const request = get().request;
    if (!request) return;
    set(state => ({
      request: null,
      pins: { ...state.pins, [request.key]: { ...point, label: request.label } },
    }));
  },
  cancel: () => set({ request: null }),
  clearPins: keyPrefix => set(state => ({
    pins: Object.fromEntries(Object.entries(state.pins).filter(([key]) => !key.startsWith(keyPrefix))),
    request: state.request?.key.startsWith(keyPrefix) ? null : state.request,
  })),
}));
