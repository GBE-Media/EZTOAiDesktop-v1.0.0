import { useCallback, useRef } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { loadPDF, getPageDimensions } from '@/lib/pdfLoader';
import '@/types/electron.d.ts';

export function useFileOpen() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { addDocument, setActiveDocument } = useEditorStore();
  const { setPdfDocument } = useCanvasStore();

  // Core function to process a PDF from ArrayBuffer
  const processFileBuffer = useCallback(async (arrayBuffer: ArrayBuffer, fileName: string, filePath?: string) => {
    try {
      // Clear product counts only when starting a brand-new project
      if (useEditorStore.getState().documents.length === 0) {
        useProductStore.getState().clearProductCounts();
      }
      
      // Clone the ArrayBuffer BEFORE loadPDF uses it (it gets detached)
      const originalBytes = arrayBuffer.slice(0);
      
      const { document: pdfDoc, numPages } = await loadPDF(arrayBuffer);
      
      // Get first page dimensions for fit-to-canvas
      const pageDimensions = await getPageDimensions(pdfDoc, 1);
      
      const docId = `doc-${Date.now()}`;
      
      addDocument({
        id: docId,
        name: fileName,
        path: filePath || '', // Store actual file path if provided, empty for browser uploads
        pages: numPages,
        currentPage: 1,
        zoom: 100,
        modified: false,
        markups: [],
        measurements: [],
      });
      
      // Pass docId, document, pages, original dimensions, AND cloned original bytes for saving
      setPdfDocument(docId, pdfDoc, numPages, pageDimensions.width, pageDimensions.height, originalBytes);
      setActiveDocument(docId);
      
      // Also set active doc ID in canvas store to sync both stores
      useCanvasStore.getState().setActiveDocId(docId);
      
      // Auto-fit to canvas with multiple retries and longer delay
      let retryCount = 0;
      const maxRetries = 30; // Try for up to ~1.5 seconds
      
      const attemptFitToCanvas = () => {
        const state = useCanvasStore.getState();
        console.log('[AUTO-FIT] Attempt', retryCount, 'Container:', state.containerWidth, 'x', state.containerHeight);
        
        if (state.containerWidth > 0 && state.containerHeight > 0) {
          console.log('[AUTO-FIT] Fitting to canvas NOW');
          state.fitToCanvas(state.containerWidth, state.containerHeight);
          
          // Force a second fit after a short delay to ensure it takes
          setTimeout(() => {
            const state2 = useCanvasStore.getState();
            console.log('[AUTO-FIT] Second fit attempt');
            state2.fitToCanvas(state2.containerWidth, state2.containerHeight);
          }, 150);
        } else if (retryCount < maxRetries) {
          retryCount++;
          // Use setTimeout instead of requestAnimationFrame for more reliable timing
          setTimeout(attemptFitToCanvas, 50);
        } else {
          console.warn('[AUTO-FIT] Failed to fit to canvas after', maxRetries, 'attempts - container may not be visible');
        }
      };
      
      // Start after a longer initial delay to let the Canvas component mount and set dimensions
      setTimeout(attemptFitToCanvas, 200);
    } catch (error) {
      console.error('Failed to load PDF:', error);
    }
  }, [addDocument, setPdfDocument, setActiveDocument]);

  const openFile = useCallback(async (file: File) => {
    if (file.type !== 'application/pdf') {
      console.error('Invalid file type. Please select a PDF file.');
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    await processFileBuffer(arrayBuffer, file.name);
  }, [processFileBuffer]);

  const triggerFileDialog = useCallback(async () => {
    // Check if running in Electron - use native dialog
    if (window.electronAPI?.isElectron) {
      try {
        const fileData = await window.electronAPI.openFile('pdf');
        if (fileData) {
          // Pass the actual file system path for Electron
          await processFileBuffer(fileData.buffer, fileData.name, fileData.path);
        }
      } catch (error) {
        console.error('Failed to open file via Electron:', error);
      }
      return;
    }

    // Fallback to browser file input
    if (!inputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf';
      input.style.display = 'none';
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const file = target.files?.[0];
        if (file) {
          openFile(file);
        }
      };
      inputRef.current = input;
      document.body.appendChild(input);
    }
    inputRef.current.click();
  }, [openFile, processFileBuffer]);

  return { openFile, triggerFileDialog };
}
