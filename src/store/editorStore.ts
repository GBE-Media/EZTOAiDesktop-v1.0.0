import { create } from 'zustand';
import type { EditorState, ToolType, Document, Markup, ToolProperties } from '@/types/editor';
import type { StampPreset } from '@/types/markup';
import { useProductStore } from './productStore';

interface EditorStore extends EditorState {
  toolProperties: ToolProperties;
  rotation: number;
  setActiveTool: (tool: ToolType) => void;
  setActiveDocument: (id: string | null) => void;
  addDocument: (doc: Document) => void;
  closeDocument: (id: string) => void;
  updateDocument: (id: string, updates: Partial<Document>) => void;
  selectMarkup: (id: string, multi?: boolean) => void;
  clearSelection: () => void;
  setScale: (scale: number | null) => void;
  setScaleUnit: (unit: string) => void;
  toggleSnap: () => void;
  toggleGrid: () => void;
  updateToolProperties: (props: Partial<ToolProperties>) => void;
  addMarkup: (docId: string, markup: Markup) => void;
  updateMarkup: (docId: string, markupId: string, updates: Partial<Markup>) => void;
  deleteMarkups: (docId: string, markupIds: string[]) => void;
  setRotation: (rotation: number) => void;
  reorderDocuments: (fromIndex: number, toIndex: number) => void;
  setSelectedStamp: (stamp: StampPreset) => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  activeTool: 'select',
  activeDocument: null,
  documents: [],
  selectedMarkups: [],
  scale: 48, // 1/4" = 1'-0"
  scaleUnit: 'ft',
  snapEnabled: true,
  gridEnabled: false,
  rotation: 0,
  selectedStamp: 'approved',
  toolProperties: {
    color: '#ef4444',
    fillColor: 'transparent',
    opacity: 100,
    lineWidth: 2,
    fontSize: 12,
    fontFamily: 'Arial',
  },

  setActiveTool: (tool) => set({ activeTool: tool }),
  
  setActiveDocument: (id) => set({ activeDocument: id, selectedMarkups: [] }),
  
  addDocument: (doc) => set((state) => ({ 
    documents: [...state.documents, doc],
    activeDocument: doc.id,
  })),
  
  closeDocument: (id) => {
    const state = get();
    const docs = state.documents.filter((d) => d.id !== id);
    const newActive = state.activeDocument === id 
      ? docs[0]?.id ?? null 
      : state.activeDocument;
    
    // If closing the last document, clear product counts
    if (docs.length === 0) {
      useProductStore.getState().clearProductCounts();
    }
    
    set({ documents: docs, activeDocument: newActive });
  },
  
  updateDocument: (id, updates) => set((state) => ({
    documents: state.documents.map((d) => 
      d.id === id ? { ...d, ...updates } : d
    ),
  })),
  
  selectMarkup: (id, multi = false) => set((state) => ({
    selectedMarkups: multi 
      ? state.selectedMarkups.includes(id)
        ? state.selectedMarkups.filter((m) => m !== id)
        : [...state.selectedMarkups, id]
      : [id],
  })),
  
  clearSelection: () => set({ selectedMarkups: [] }),
  
  setScale: (scale) => set({ scale }),
  
  setScaleUnit: (unit) => set({ scaleUnit: unit }),
  
  toggleSnap: () => set((state) => ({ snapEnabled: !state.snapEnabled })),
  
  toggleGrid: () => set((state) => ({ gridEnabled: !state.gridEnabled })),
  
  updateToolProperties: (props) => set((state) => ({
    toolProperties: { ...state.toolProperties, ...props },
  })),
  
  addMarkup: (docId, markup) => set((state) => ({
    documents: state.documents.map((d) =>
      d.id === docId 
        ? { ...d, markups: [...d.markups, markup], modified: true }
        : d
    ),
  })),
  
  updateMarkup: (docId, markupId, updates) => set((state) => ({
    documents: state.documents.map((d) =>
      d.id === docId
        ? {
            ...d,
            markups: d.markups.map((m) =>
              m.id === markupId ? { ...m, ...updates } : m
            ),
            modified: true,
          }
        : d
    ),
  })),
  
  deleteMarkups: (docId, markupIds) => set((state) => ({
    documents: state.documents.map((d) =>
      d.id === docId
        ? {
            ...d,
            markups: d.markups.filter((m) => !markupIds.includes(m.id)),
            modified: true,
          }
        : d
    ),
    selectedMarkups: state.selectedMarkups.filter((id) => !markupIds.includes(id)),
  })),
  
  setRotation: (rotation) => set({ rotation }),
  
  reorderDocuments: (fromIndex, toIndex) => set((state) => {
    const docs = [...state.documents];
    const [removed] = docs.splice(fromIndex, 1);
    docs.splice(toIndex, 0, removed);
    return { documents: docs };
  }),
  
  setSelectedStamp: (stamp) => set({ selectedStamp: stamp }),
}));
