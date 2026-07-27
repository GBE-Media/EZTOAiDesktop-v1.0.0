import { useCallback, useRef } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { loadPDF, getPageDimensions } from '@/lib/pdfLoader';
import { useProjectOpen } from '@/hooks/useProjectOpen';
import { toast } from 'sonner';
import '@/types/electron.d.ts';

export function useFileOpen() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { addDocument, setActiveDocument } = useEditorStore();
  const { setPdfDocument } = useCanvasStore();
  const { openProject } = useProjectOpen();

  // Core function to process a PDF from ArrayBuffer
  const processFileBuffer = useCallback(async (arrayBuffer: ArrayBuffer, fileName: string, filePath?: string) => {
    try {
      // Always clear product counts when opening a new PDF file
      // This ensures the user starts fresh with each new document
      // Saved projects (.bidveraai files) load their own measurements via useProjectOpen
      useProductStore.getState().clearProductCounts();
      
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
    } catch (error) {
      console.error('Failed to load PDF:', error);
    }
  }, [addDocument, setPdfDocument, setActiveDocument]);

  // Process .bidveraai project file from ArrayBuffer
  const processProjectBuffer = useCallback(async (arrayBuffer: ArrayBuffer, fileName: string, filePath?: string) => {
    try {
      const jsonString = new TextDecoder().decode(arrayBuffer);
      const projectData = JSON.parse(jsonString);
      
      // Validate project data
      if (!projectData.version || !projectData.documents) {
        toast.error('Invalid project file');
        return;
      }
      
      await openProject(projectData, filePath);
    } catch (error) {
      console.error('Failed to load project:', error);
      toast.error('Failed to load project file');
    }
  }, [openProject]);

  const openFile = useCallback(async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    
    // Handle .bidveraai project files
    if (file.name.endsWith('.bidveraai')) {
      await processProjectBuffer(arrayBuffer, file.name);
      return;
    }
    
    // Handle PDF files
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      await processFileBuffer(arrayBuffer, file.name);
      return;
    }
    
    toast.error('Please select a PDF or BidveraAi project file');
  }, [processFileBuffer, processProjectBuffer]);

  const triggerFileDialog = useCallback(async () => {
    // Check if running in Electron - use native dialog
    if (window.electronAPI?.isElectron) {
      try {
        // Open dialog that accepts both PDF and project files
        const fileData = await window.electronAPI.openFile();
        if (fileData) {
          // Determine file type and process accordingly
          if (fileData.name.endsWith('.bidveraai')) {
            await processProjectBuffer(fileData.buffer, fileData.name, fileData.path);
          } else {
            await processFileBuffer(fileData.buffer, fileData.name, fileData.path);
          }
        }
      } catch (error) {
        console.error('Failed to open file via Electron:', error);
      }
      return;
    }

    // Fallback to browser file input - accept both PDFs and .bidveraai files
    if (!inputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.bidveraai';
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
  }, [openFile, processFileBuffer, processProjectBuffer]);

  return { openFile, triggerFileDialog, processFileBuffer, processProjectBuffer };
}
