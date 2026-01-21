import { useCallback } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { loadPDF, getPageDimensions } from '@/lib/pdfLoader';
import { toast } from 'sonner';
import type { ProjectFile } from '@/types/project';

export function useProjectOpen() {
  const { addDocument, setActiveDocument, setScale, setScaleUnit, toggleSnap, toggleGrid, snapEnabled, gridEnabled } = useEditorStore();
  const { setPdfDocument, setMarkupsForPage, setActiveDocId } = useCanvasStore();
  const { loadFromDatabase } = useProductStore();

  const openProject = useCallback(async (projectData: ProjectFile, projectPath?: string) => {
    try {
      toast.loading('Loading project...', { id: 'load-project' });

      // Clear existing documents directly without triggering clearProductCounts
      // (We want to preserve the product data that's being loaded from the project file)
      useEditorStore.setState({ documents: [], activeDocument: null, selectedMarkups: [] });
      
      // Clear canvas store completely
      useCanvasStore.getState().clearAllDocuments();

      // Prepare document ID map (preserve IDs when possible)
      const docIdMap = new Map<string, string>();
      projectData.documents.forEach((projDoc, idx) => {
        const resolvedId = projDoc.id || `doc-${Date.now()}-${idx}`;
        docIdMap.set(projDoc.id || `__missing_${idx}`, resolvedId);
      });

      // Restore settings
      if (projectData.settings) {
        setScale(projectData.settings.scale);
        setScaleUnit(projectData.settings.scaleUnit);
        
        if (projectData.settings.snapEnabled !== snapEnabled) {
          toggleSnap();
        }
        if (projectData.settings.gridEnabled !== gridEnabled) {
          toggleGrid();
        }
      }

      // Restore products (replace existing), remapping document IDs if needed
      if (projectData.products) {
        const remappedNodes: Record<string, any> = {};
        Object.entries(projectData.products.nodes).forEach(([id, node]) => {
          if (node.type === 'product') {
            const measurements = (node.measurements || []).map((m: any) => ({
              ...m,
              documentId: docIdMap.get(m.documentId) || m.documentId,
            }));
            remappedNodes[id] = { ...node, measurements };
          } else {
            remappedNodes[id] = node;
          }
        });

        loadFromDatabase(remappedNodes, projectData.products.rootIds);
      }

      // Restore documents (reuse stored IDs so product measurements stay linked)
      let firstDocId: string | null = null;
      
      for (let docIndex = 0; docIndex < projectData.documents.length; docIndex++) {
        const projDoc = projectData.documents[docIndex];
        
        try {
          console.log('[PROJECT-OPEN] Loading document:', projDoc.name);
          
          // Decode base64 PDF data
          const binaryString = atob(projDoc.pdfData);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const arrayBuffer = bytes.buffer;

          // Clone for PDF.js
          const originalBytes = arrayBuffer.slice(0);

          // Load PDF
          console.log('[PROJECT-OPEN] Loading PDF...');
          const { document: pdfDoc, numPages } = await loadPDF(arrayBuffer);
          const pageDimensions = await getPageDimensions(pdfDoc, 1);
          console.log('[PROJECT-OPEN] PDF loaded, pages:', numPages);

          // Reuse stored document ID to keep measurements linked to the correct PDF
          const newDocId = docIdMap.get(projDoc.id || `__missing_${docIndex}`) || `doc-${Date.now()}-${docIndex}`;
          
          // Track first document ID for activation
          if (docIndex === 0) {
            firstDocId = newDocId;
          }

          // Extract project filename to use as document name
          const projectFileName = projectPath ? projectPath.split(/[\\/]/).pop() : projDoc.name;

          // Add document to store
          addDocument({
            id: newDocId,
            name: projectFileName || projDoc.name, // Use .ezto filename instead of PDF name
            path: projectPath || '', // Store project path, not individual PDF path
            pages: projDoc.pages || numPages,
            currentPage: projDoc.currentPage || 1,
            zoom: projDoc.zoom || 100,
            modified: false,
            markups: projDoc.markups || [],
            measurements: projDoc.measurements || [],
          });

          // Set PDF document in canvas store with NEW ID
          setPdfDocument(
            newDocId,
            pdfDoc,
            numPages,
            pageDimensions.width,
            pageDimensions.height,
            originalBytes
          );

          // Set first document as active BEFORE restoring markups
          if (docIndex === 0) {
            console.log('[PROJECT-OPEN] Setting active document:', newDocId);
            setActiveDocument(newDocId);
            setActiveDocId(newDocId); // Sync canvas store's active document
            
            // Small delay to ensure state is updated
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          // Restore markups to canvas store (make them editable again)
          if (projDoc.markups && Array.isArray(projDoc.markups) && projDoc.markups.length > 0) {
            console.log('[PROJECT-OPEN] Restoring', projDoc.markups.length, 'markups');
            
            // Group markups by page
            const markupsByPage: Record<number, any[]> = {};
            projDoc.markups.forEach((markup: any) => {
              const page = markup.page || 1;
              if (!markupsByPage[page]) {
                markupsByPage[page] = [];
              }
              markupsByPage[page].push(markup);
            });
            
            // Set markups for each page in canvas store
            Object.entries(markupsByPage).forEach(([page, pageMarkups]) => {
              setMarkupsForPage(parseInt(page), pageMarkups);
            });
            
            console.log('[PROJECT-OPEN] Restored markups for document:', newDocId, 'Pages:', Object.keys(markupsByPage));
          }
          
          console.log('[PROJECT-OPEN] Document loaded successfully:', newDocId);
        } catch (error) {
          console.error(`[PROJECT-OPEN] Failed to load document ${projDoc.name}:`, error);
          toast.error(`Failed to load ${projDoc.name}`);
        }
      }

      // Trigger auto-fit after all documents are loaded
      if (firstDocId) {
        setTimeout(() => {
          const state = useCanvasStore.getState();
          if (state.containerWidth > 0 && state.containerHeight > 0) {
            console.log('[PROJECT-OPEN] Auto-fitting to canvas');
            state.fitToCanvas(state.containerWidth, state.containerHeight);
          }
        }, 200);
      }

      toast.success(`Project "${projectData.name}" loaded`, { id: 'load-project' });
      return true;
    } catch (error) {
      console.error('Failed to load project:', error);
      toast.error('Failed to load project', { id: 'load-project' });
      return false;
    }
  }, [addDocument, setPdfDocument, setMarkupsForPage, setActiveDocument, setActiveDocId, setScale, setScaleUnit, toggleSnap, toggleGrid, snapEnabled, gridEnabled, loadFromDatabase]);

  const openProjectFile = useCallback(async () => {
    if (!window.electronAPI?.openFile) {
      toast.error('File opening not supported in browser');
      return;
    }

    try {
      const fileData = await window.electronAPI.openFile('project');
      if (!fileData) return;

      // Check if it's a project file
      if (!fileData.name.endsWith('.ezto')) {
        toast.error('Please select an EZTO project file (.ezto)');
        return;
      }

      // Parse JSON
      const jsonString = new TextDecoder().decode(fileData.buffer);
      const projectData: ProjectFile = JSON.parse(jsonString);

      // Validate project data
      if (!projectData.version || !projectData.documents) {
        toast.error('Invalid project file');
        return;
      }

      // Load the project
      await openProject(projectData, fileData.path);
    } catch (error) {
      console.error('Failed to open project file:', error);
      toast.error('Failed to open project file');
    }
  }, [openProject]);

  return {
    openProject,
    openProjectFile,
  };
}
