import { create } from 'zustand';
import type { CanvasMarkup } from '@/types/markup';
import type { LinkedMeasurement } from '@/types/product';

interface HistoryEntry {
  id: string;
  timestamp: number;
  action: 'add' | 'update' | 'delete' | 'batch';
  page: number;
  before: CanvasMarkup[] | null;
  after: CanvasMarkup[] | null;
  description: string;
  linkedMeasurements?: Array<{
    productId: string;
    measurement: Omit<LinkedMeasurement, 'id' | 'createdAt'>;
  }>;
}

interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
  maxHistory: number;
}

interface HistoryActions {
  pushHistory: (entry: Omit<HistoryEntry, 'id' | 'timestamp'>) => void;
  undo: () => HistoryEntry | null;
  redo: () => HistoryEntry | null;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clearHistory: () => void;
  getHistoryCount: () => { past: number; future: number };
}

const generateId = () => `history_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

export const useHistoryStore = create<HistoryState & HistoryActions>((set, get) => ({
  past: [],
  future: [],
  maxHistory: 50,

  pushHistory: (entry) => set((state) => {
    const newEntry: HistoryEntry = {
      ...entry,
      id: generateId(),
      timestamp: Date.now(),
    };

    const newPast = [...state.past, newEntry];
    
    // Limit history size
    if (newPast.length > state.maxHistory) {
      newPast.shift();
    }

    return {
      past: newPast,
      future: [], // Clear redo stack when new action is performed
    };
  }),

  undo: () => {
    const state = get();
    if (state.past.length === 0) return null;

    const lastEntry = state.past[state.past.length - 1];
    
    set({
      past: state.past.slice(0, -1),
      future: [lastEntry, ...state.future],
    });

    return lastEntry;
  },

  redo: () => {
    const state = get();
    if (state.future.length === 0) return null;

    const nextEntry = state.future[0];
    
    set({
      past: [...state.past, nextEntry],
      future: state.future.slice(1),
    });

    return nextEntry;
  },

  canUndo: () => get().past.length > 0,

  canRedo: () => get().future.length > 0,

  clearHistory: () => set({ past: [], future: [] }),

  getHistoryCount: () => {
    const state = get();
    return { past: state.past.length, future: state.future.length };
  },
}));
