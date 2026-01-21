import { useEffect, useCallback } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useHistoryStore } from '@/store/historyStore';
import { useFileOpen } from '@/hooks/useFileOpen';
import { useProjectSave } from '@/hooks/useProjectSave';
import { useProjectOpen } from '@/hooks/useProjectOpen';
import { toast } from 'sonner';
import type { ToolType } from '@/types/editor';

// Get history methods directly from store (not as hooks)
const getHistoryState = () => useHistoryStore.getState();

const KEYBOARD_SHORTCUTS: Record<string, ToolType | 'action'> = {
  'v': 'select',
  'h': 'pan',
  't': 'text',
  'c': 'cloud',
  'r': 'rectangle',
  'e': 'ellipse',
  'l': 'line',
  'a': 'arrow',
  'p': 'freehand',
  'm': 'measure-length',
  'o': 'callout',
  'g': 'polygon',
  'y': 'polyline',
  's': 'stamp',
  'x': 'eraser',
  'i': 'highlight',
  'n': 'count',
};

export function useKeyboardShortcuts() {
  const { setActiveTool, toggleGrid, toggleSnap } = useEditorStore();
  const { 
    pdfDocuments,
    activeDocId,
    setZoom, 
    zoom, 
    startCalibration,
    setCurrentPage,
    clearSelection,
    selectedMarkupIds,
    deleteMarkups,
    undo,
    redo,
    drawing,
    cancelDrawing,
  } = useCanvasStore();
  const { triggerFileDialog } = useFileOpen();
  const { saveProject, saveProjectAs } = useProjectSave();
  const { openProjectFile } = useProjectOpen();

  // Derive page info from document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const currentPage = currentDocData?.currentPage || 1;
  const totalPages = currentDocData?.totalPages || 0;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if user is typing in an input
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target as HTMLElement)?.isContentEditable
    ) {
      return;
    }

    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    // Ctrl/Cmd shortcuts
    if (ctrl) {
      switch (key) {
        case 'o':
          e.preventDefault();
          // Ctrl+O = Open Project
          openProjectFile();
          break;
        case 's':
          e.preventDefault();
          if (shift) {
            // Ctrl+Shift+S = Save Project As
            saveProjectAs();
          } else {
            // Ctrl+S = Save Project
            saveProject();
          }
          break;
        case 'z':
          e.preventDefault();
          if (shift) {
            // Ctrl+Shift+Z = Redo
            if (getHistoryState().canRedo()) {
              redo();
              toast.success('Redo');
            }
          } else {
            // Ctrl+Z = Undo
            if (getHistoryState().canUndo()) {
              undo();
              toast.success('Undo');
            }
          }
          break;
        case 'y':
          e.preventDefault();
          // Ctrl+Y = Redo
          if (getHistoryState().canRedo()) {
            redo();
            toast.success('Redo');
          }
          break;
        case 'a':
          e.preventDefault();
          // Select all (placeholder)
          break;
        case '=':
        case '+':
          e.preventDefault();
          setZoom(Math.min(zoom + 25, 400));
          break;
        case '-':
          e.preventDefault();
          setZoom(Math.max(zoom - 25, 25));
          break;
        case '0':
          e.preventDefault();
          setZoom(100);
          break;
        case 'g':
          e.preventDefault();
          toggleGrid();
          break;
      }
      return;
    }

    // Shift shortcuts
    if (shift) {
      switch (key) {
        case 's':
          e.preventDefault();
          toggleSnap();
          break;
        case 'c':
          e.preventDefault();
          startCalibration();
          break;
      }
      return;
    }

    // Single key shortcuts for tools
    if (KEYBOARD_SHORTCUTS[key]) {
      e.preventDefault();
      const tool = KEYBOARD_SHORTCUTS[key];
      if (tool !== 'action') {
        setActiveTool(tool);
      }
      return;
    }

    // Other shortcuts
    switch (key) {
      case 'escape':
        e.preventDefault();
        clearSelection();
        // If actively drawing, cancel the drawing but keep the tool selected
        if (drawing.isDrawing) {
          cancelDrawing();
        } else {
          // If not drawing, revert to select tool
          setActiveTool('select');
        }
        break;
      case 'delete':
      case 'backspace':
        if (selectedMarkupIds.length > 0) {
          e.preventDefault();
          deleteMarkups(currentPage, selectedMarkupIds);
        }
        break;
      case 'pageup':
        e.preventDefault();
        if (currentPage > 1) {
          setCurrentPage(currentPage - 1);
        }
        break;
      case 'pagedown':
        e.preventDefault();
        if (currentPage < totalPages) {
          setCurrentPage(currentPage + 1);
        }
        break;
      case 'home':
        e.preventDefault();
        setCurrentPage(1);
        break;
      case 'end':
        e.preventDefault();
        setCurrentPage(totalPages);
        break;
      case '[':
        setZoom(Math.max(zoom - 10, 25));
        break;
      case ']':
        setZoom(Math.min(zoom + 10, 400));
        break;
    }
  }, [
    setActiveTool, 
    toggleGrid, 
    toggleSnap, 
    setZoom, 
    zoom, 
    triggerFileDialog,
    startCalibration,
    currentPage,
    totalPages,
    setCurrentPage,
    clearSelection,
    selectedMarkupIds,
    deleteMarkups,
    undo,
    redo,
    saveProject,
    saveProjectAs,
    openProjectFile,
    drawing,
    cancelDrawing,
  ]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

// Export shortcut map for display in UI
export const SHORTCUT_LABELS: Record<string, string> = {
  'select': 'V',
  'pan': 'H',
  'text': 'T',
  'cloud': 'C',
  'rectangle': 'R',
  'ellipse': 'E',
  'line': 'L',
  'arrow': 'A',
  'freehand': 'P',
  'measure-length': 'M',
  'callout': 'O',
  'polygon': 'G',
  'polyline': 'Y',
  'stamp': 'S',
  'eraser': 'X',
  'highlight': 'I',
  'count': 'N',
};
