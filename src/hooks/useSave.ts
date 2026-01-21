import { useCallback } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { exportPdfWithMarkups, downloadPdf } from '@/lib/pdfExport';
import { toast } from 'sonner';

interface SaveResult {
  success: boolean;
  path?: string;
  name?: string;
}

export function useSave() {
  const { documents, activeDocument, updateDocument } = useEditorStore();
  const { getOriginalPdfBytes, getMarkupsByPage } = useCanvasStore();

  const getExportedPdfBytes = useCallback(async (): Promise<ArrayBuffer | null> => {
    const originalBytes = getOriginalPdfBytes();
    const markupsByPage = getMarkupsByPage();

    if (!originalBytes) {
      toast.error('No PDF data available');
      return null;
    }

    try {
      const pdfBytes = await exportPdfWithMarkups(originalBytes, markupsByPage);
      // Convert Uint8Array to ArrayBuffer properly
      const arrayBuffer = new ArrayBuffer(pdfBytes.byteLength);
      new Uint8Array(arrayBuffer).set(pdfBytes);
      return arrayBuffer;
    } catch (error) {
      console.error('Failed to export PDF:', error);
      toast.error('Failed to export PDF');
      return null;
    }
  }, [getOriginalPdfBytes, getMarkupsByPage]);

  // Save As - always shows native dialog
  const saveAs = useCallback(async (docId?: string): Promise<boolean> => {
    const targetId = docId || activeDocument;
    const doc = documents.find(d => d.id === targetId);
    if (!doc) return false;

    toast.loading('Preparing to save...', { id: 'save-pdf' });

    const arrayBuffer = await getExportedPdfBytes();
    if (!arrayBuffer) {
      toast.error('Failed to save', { id: 'save-pdf' });
      return false;
    }

    try {
      if (window.electronAPI?.isElectron) {
        // Use native Save As dialog
        const result = await window.electronAPI.saveFile(arrayBuffer, doc.name);
        
        if (result.success && result.path) {
          updateDocument(doc.id, {
            modified: false,
            path: result.path,
            name: result.name || doc.name,
          });
          toast.success(`Saved as "${result.name}"`, { id: 'save-pdf' });
          return true;
        } else if (result.canceled) {
          toast.dismiss('save-pdf');
          return false;
        } else {
          toast.error('Failed to save', { id: 'save-pdf' });
          return false;
        }
      } else {
        // Browser fallback - download file
        const { downloadPdf } = await import('@/lib/pdfExport');
        const pdfBytes = new Uint8Array(arrayBuffer);
        downloadPdf(pdfBytes, doc.name);
        updateDocument(doc.id, { modified: false });
        toast.success('Downloaded', { id: 'save-pdf' });
        return true;
      }
    } catch (error) {
      console.error('Save As failed:', error);
      toast.error('Failed to save', { id: 'save-pdf' });
      return false;
    }
  }, [activeDocument, documents, updateDocument, getExportedPdfBytes]);

  // Save to existing path (overwrite) or trigger Save As if no path
  const save = useCallback(async (docId?: string): Promise<boolean> => {
    const targetId = docId || activeDocument;
    const doc = documents.find(d => d.id === targetId);
    if (!doc) {
      console.log('[SAVE] No document found');
      return false;
    }

    console.log('[SAVE] Document:', { name: doc.name, path: doc.path, hasPath: !!doc.path });

    // Check if we have a file system path (Electron only)
    // The path should be a real file path, not a blob URL, and not empty
    const hasRealPath = doc.path && 
                       doc.path.trim() !== '' && 
                       !doc.path.startsWith('blob:') && 
                       window.electronAPI?.isElectron;

    console.log('[SAVE] Has real path:', hasRealPath, 'Path:', doc.path);

    if (hasRealPath) {
      // Direct overwrite to existing path (Bluebeam behavior)
      toast.loading(`Saving to ${doc.name}...`, { id: 'save-pdf' });
      
      const arrayBuffer = await getExportedPdfBytes();
      if (!arrayBuffer) {
        toast.error('Failed to save', { id: 'save-pdf' });
        return false;
      }

      try {
        console.log('[SAVE] Saving directly to:', doc.path);
        const result = await window.electronAPI!.saveFileDirect(arrayBuffer, doc.path);
        if (result.success) {
          updateDocument(doc.id, { modified: false });
          toast.success(`Saved to ${doc.name}`, { id: 'save-pdf' });
          return true;
        } else {
          toast.error('Failed to save: ' + result.error, { id: 'save-pdf' });
          return false;
        }
      } catch (error) {
        console.error('Save failed:', error);
        toast.error('Failed to save', { id: 'save-pdf' });
        return false;
      }
    } else {
      // No existing path - trigger Save As (first time save)
      console.log('[SAVE] No path, triggering Save As');
      return await saveAs(docId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDocument, documents, updateDocument, getExportedPdfBytes]);

  return { save, saveAs };
}
