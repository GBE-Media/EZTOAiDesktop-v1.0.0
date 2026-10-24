import { create } from 'zustand';

type Progress = { indexed: number; total: number };

interface IndexProgressState {
  byDoc: Record<string, Progress>;
  setProgress: (docId: string, indexed: number, total: number) => void;
  clearDoc: (docId: string) => void;
}

export const useIndexProgressStore = create<IndexProgressState>(set => ({
  byDoc: {},
  setProgress: (docId, indexed, total) => set(state => ({
    byDoc: { ...state.byDoc, [docId]: { indexed, total } },
  })),
  clearDoc: (docId) => set(state => {
    const next = { ...state.byDoc };
    delete next[docId];
    return { byDoc: next };
  }),
}));
