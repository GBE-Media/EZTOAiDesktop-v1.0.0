import { useCallback, useRef } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { loadPDF, loadPDFFromUrl, getPageDimensions } from '@/lib/pdfLoader';
import { useProjectOpen } from '@/hooks/useProjectOpen';
import { toast } from 'sonner';
import '@/types/electron.d.ts';

function bidveraFileUrl(filePath: string): string {
  return `bidvera-file://local/?p=${encodeURIComponent(filePath)}`;
}

export function useFileOpen() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { addDocument, setActiveDocument } = useEditorStore();
  const { setPdfDocument } = useCanvasStore();
  const { openProject } = useProjectOpen();

  const attachPdf = useCallback(async (
    pdfDoc: Awaited<ReturnType<typeof loadPDF>>['document'],
    numPages: number,
    fileName: string,
    filePath: string | undefined,
    originalBytes?: ArrayBuffer,
  ) => {
    useProductStore.getState().clearProductCounts();
    const pageDimensions = await getPageDimensions(pdfDoc, 1);
    const docId = `doc-${Date.now()}`;
    addDocument({
      id: docId,
      name: fileName,
      path: filePath || '',
      pages: numPages,
      currentPage: 1,
      zoom: 100,
      modified: false,
      markups: [],
      measurements: [],
    });
    setPdfDocument(
      docId,
      pdfDoc,
      numPages,
      pageDimensions.width,
      pageDimensions.height,
      originalBytes,
      filePath && !originalBytes ? { source: 'file', path: filePath } : originalBytes
        ? { source: 'memory', bytes: originalBytes }
        : undefined,
    );
    setActiveDocument(docId);
    useCanvasStore.getState().setActiveDocId(docId);
  }, [addDocument, setPdfDocument, setActiveDocument]);

  const processFileBuffer = useCallback(async (arrayBuffer: ArrayBuffer, fileName: string, filePath?: string) => {
    try {
      const { document: pdfDoc, numPages } = await loadPDF(arrayBuffer);
      await attachPdf(pdfDoc, numPages, fileName, filePath, arrayBuffer);
    } catch (error) {
      console.error('Failed to load PDF:', error);
    }
  }, [attachPdf]);

  const processFileFromDisk = useCallback(async (filePath: string, fileName: string, url?: string) => {
    try {
      await window.electronAPI?.allowLocalPath?.(filePath);
      const { document: pdfDoc, numPages } = await loadPDFFromUrl(url || bidveraFileUrl(filePath));
      await attachPdf(pdfDoc, numPages, fileName, filePath);
    } catch (error) {
      console.error('Failed to load PDF from disk:', error);
      toast.error('Failed to open PDF');
    }
  }, [attachPdf]);

  const processProjectBuffer = useCallback(async (arrayBuffer: ArrayBuffer, fileName: string, filePath?: string) => {
    try {
      const jsonString = new TextDecoder().decode(arrayBuffer);
      const projectData = JSON.parse(jsonString);
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
    if (file.name.endsWith('.bidveraai')) {
      await processProjectBuffer(arrayBuffer, file.name);
      return;
    }
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      await processFileBuffer(arrayBuffer, file.name);
      return;
    }
    toast.error('Please select a PDF or BidveraAi project file');
  }, [processFileBuffer, processProjectBuffer]);

  const triggerFileDialog = useCallback(async () => {
    if (window.electronAPI?.isElectron) {
      try {
        const fileData = await window.electronAPI.openFile();
        if (!fileData) return;
        if (fileData.name.endsWith('.bidveraai')) {
          if (!fileData.buffer) {
            toast.error('Failed to read project file');
            return;
          }
          await processProjectBuffer(fileData.buffer, fileData.name, fileData.path);
        } else if (fileData.path && !fileData.buffer) {
          await processFileFromDisk(fileData.path, fileData.name, fileData.url);
        } else if (fileData.buffer) {
          await processFileBuffer(fileData.buffer, fileData.name, fileData.path);
        }
      } catch (error) {
        console.error('Failed to open file via Electron:', error);
      }
      return;
    }

    if (!inputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf,.bidveraai';
      input.style.display = 'none';
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const file = target.files?.[0];
        if (file) openFile(file);
      };
      inputRef.current = input;
      document.body.appendChild(input);
    }
    inputRef.current.click();
  }, [openFile, processFileBuffer, processProjectBuffer, processFileFromDisk]);

  return { openFile, triggerFileDialog, processFileBuffer, processProjectBuffer };
}
