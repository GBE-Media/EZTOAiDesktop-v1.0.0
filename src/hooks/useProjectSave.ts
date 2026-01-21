import { useCallback } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { exportPdfWithMarkups } from '@/lib/pdfExport';
import { toast } from 'sonner';
import type { ProjectFile, ProjectDocument, SaveProjectResult } from '@/types/project';

const PROJECT_VERSION = '1.0.0';
const PROJECT_EXTENSION = 'ezto';

export function useProjectSave() {
  const { 
    documents, 
    scale, 
    scaleUnit, 
    snapEnabled, 
    gridEnabled,
    updateDocument 
  } = useEditorStore();
  
  const { pdfDocuments, getOriginalPdfBytes, getMarkupsByPage } = useCanvasStore();
  const { nodes, rootIds } = useProductStore();

  // Get current project file path from first document (or store separately)
  const getCurrentProjectPath = useCallback((): string | null => {
    // We'll store the project path in a special way
    // For now, check if any document has a .ezto path
    const doc = documents.find(d => d.path?.endsWith('.ezto'));
    return doc?.path || null;
  }, [documents]);

  // Export all PDFs with their markups as base64
  const exportDocumentsData = useCallback(async (): Promise<ProjectDocument[]> => {
    const projectDocs: ProjectDocument[] = [];

    for (const doc of documents) {
      const docData = pdfDocuments[doc.id];
      if (!docData) continue;

      try {
        // Get ORIGINAL PDF bytes (without markups baked in)
        const originalBytes = getOriginalPdfBytes(doc.id);
        if (!originalBytes) continue;

        // Get markups for this document from canvas store (the actual editable markups)
        const markupsByPage = getMarkupsByPage(doc.id);
        
        // Flatten markups from all pages into a single array for saving
        const allMarkups: any[] = [];
        Object.entries(markupsByPage).forEach(([page, pageMarkups]) => {
          pageMarkups.forEach((markup: any) => {
            allMarkups.push({ ...markup, page: parseInt(page) });
          });
        });
        
        console.log('[PROJECT-SAVE] Saving markups for doc:', doc.id, 'Count:', allMarkups.length);
        
        // Convert ORIGINAL PDF to base64 (keep it clean for editing)
        const uint8Array = new Uint8Array(originalBytes);
        const base64Pdf = btoa(
          Array.from(uint8Array)
            .map(byte => String.fromCharCode(byte))
            .join('')
        );

        // Save everything separately so markups remain editable
        projectDocs.push({
          id: doc.id,
          name: doc.name,
          originalPath: doc.path?.endsWith('.ezto') ? undefined : doc.path,
          pdfData: base64Pdf, // Original PDF without markups
          pages: doc.pages,
          currentPage: doc.currentPage,
          zoom: doc.zoom,
          markups: allMarkups, // Editable markup data from canvas store
          measurements: doc.measurements, // Editable measurement data
        });
      } catch (error) {
        console.error(`Failed to export document ${doc.name}:`, error);
      }
    }

    return projectDocs;
  }, [documents, pdfDocuments, getOriginalPdfBytes, getMarkupsByPage]);

  // Create project file data
  const createProjectData = useCallback(async (projectName: string): Promise<ProjectFile> => {
    const projectDocs = await exportDocumentsData();
    const docIdSet = new Set(projectDocs.map((doc) => doc.id));
    
    // Get the latest product state directly from the store
    const productState = useProductStore.getState();
    const currentNodes = productState.nodes;
    const currentRootIds = productState.rootIds;

    // Filter measurements to only those tied to documents in this project
    const sanitizedNodes: Record<string, any> = {};
    Object.entries(currentNodes).forEach(([id, node]: [string, any]) => {
      if (node.type === 'product') {
        sanitizedNodes[id] = {
          ...node,
          measurements: (node.measurements || []).filter((m: any) => docIdSet.has(m.documentId)),
        };
      } else {
        sanitizedNodes[id] = node;
      }
    });
    
    console.log('[PROJECT-SAVE] Saving products:', {
      nodeCount: Object.keys(currentNodes).length,
      rootIdCount: currentRootIds.length,
      products: Object.values(currentNodes).filter((n: any) => n.type === 'product').map((n: any) => ({
        name: n.name,
        measurementCount: n.measurements?.length || 0,
      })),
    });

    return {
      version: PROJECT_VERSION,
      name: projectName,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      documents: projectDocs,
      products: {
        nodes: sanitizedNodes,
        rootIds: currentRootIds,
      },
      settings: {
        scale,
        scaleUnit,
        snapEnabled,
        gridEnabled,
      },
    };
  }, [exportDocumentsData, nodes, rootIds, scale, scaleUnit, snapEnabled, gridEnabled]);

  // Save project to existing path
  const saveProject = useCallback(async (): Promise<boolean> => {
    const projectPath = getCurrentProjectPath();

    if (!projectPath) {
      // No existing project path, do Save As
      return await saveProjectAs();
    }

    toast.loading('Saving project...', { id: 'save-project' });

    try {
      // Get project name from path
      const projectName = projectPath.split(/[\\/]/).pop()?.replace('.ezto', '') || 'Untitled';
      
      const projectData = await createProjectData(projectName);
      const jsonData = JSON.stringify(projectData, null, 2);
      const arrayBuffer = new TextEncoder().encode(jsonData).buffer;

      if (window.electronAPI?.saveFileDirect) {
        const result = await window.electronAPI.saveFileDirect(arrayBuffer, projectPath);
        
        if (result.success) {
          // Extract filename from path and update document name
          const fileName = projectPath.split(/[\\/]/).pop() || 'Untitled.ezto';
          
          // Mark all documents as saved and update name
          documents.forEach(doc => {
            updateDocument(doc.id, { modified: false, path: projectPath, name: fileName });
          });
          
          toast.success('Project saved', { id: 'save-project' });
          return true;
        } else {
          toast.error('Failed to save project: ' + result.error, { id: 'save-project' });
          return false;
        }
      } else {
        // Browser fallback - download as file
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${projectName}.${PROJECT_EXTENSION}`;
        a.click();
        URL.revokeObjectURL(url);
        
        toast.success('Project downloaded', { id: 'save-project' });
        return true;
      }
    } catch (error) {
      console.error('Failed to save project:', error);
      toast.error('Failed to save project', { id: 'save-project' });
      return false;
    }
  }, [getCurrentProjectPath, createProjectData, documents, updateDocument]);

  // Save project with dialog (Save As)
  const saveProjectAs = useCallback(async (): Promise<boolean> => {
    toast.loading('Preparing project...', { id: 'save-project' });

    try {
      const defaultName = documents[0]?.name.replace('.pdf', '') || 'Untitled';
      const projectData = await createProjectData(defaultName);
      const jsonData = JSON.stringify(projectData, null, 2);
      const arrayBuffer = new TextEncoder().encode(jsonData).buffer;

      if (window.electronAPI?.saveFile) {
        const result = await window.electronAPI.saveFile(
          arrayBuffer,
          `${defaultName}.${PROJECT_EXTENSION}`
        );

        if (result.success && result.path) {
          // Extract filename from path
          const fileName = result.path.split(/[\\/]/).pop() || result.name || 'Untitled.ezto';
          
          // Mark all documents as saved and update path and name
          documents.forEach(doc => {
            updateDocument(doc.id, { modified: false, path: result.path, name: fileName });
          });
          
          toast.success(`Project saved as "${result.name}"`, { id: 'save-project' });
          return true;
        } else if (result.canceled) {
          toast.dismiss('save-project');
          return false;
        } else {
          toast.error('Failed to save project', { id: 'save-project' });
          return false;
        }
      } else {
        // Browser fallback
        const blob = new Blob([jsonData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${defaultName}.${PROJECT_EXTENSION}`;
        a.click();
        URL.revokeObjectURL(url);
        
        toast.success('Project downloaded', { id: 'save-project' });
        return true;
      }
    } catch (error) {
      console.error('Failed to save project:', error);
      toast.error('Failed to save project', { id: 'save-project' });
      return false;
    }
  }, [documents, createProjectData, updateDocument]);

  return {
    saveProject,
    saveProjectAs,
    getCurrentProjectPath,
  };
}
