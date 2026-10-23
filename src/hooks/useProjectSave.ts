import { useCallback } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { toast } from 'sonner';
import type { ProjectFile, ProjectDocument } from '@/types/project';
import type { LinkedMeasurement, ProductNode } from '@/types/product';
import { sha256Hex } from '@/lib/base64Chunks';

const PROJECT_VERSION = '2';
const PROJECT_EXTENSION = 'bidveraai';

function dirname(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]+$/, '');
}

export function useProjectSave() {
  const {
    documents,
    scale,
    scaleUnit,
    snapEnabled,
    gridEnabled,
    updateDocument,
  } = useEditorStore();

  const { pdfDocuments, getOriginalPdfBytesAsync, getMarkupsByPage } = useCanvasStore();
  const { nodes, rootIds } = useProductStore();

  const getCurrentProjectPath = useCallback((): string | null => {
    const doc = documents.find(d => d.path?.endsWith('.bidveraai'));
    return doc?.path || null;
  }, [documents]);

  const writeAsset = useCallback(async (projectPath: string, docId: string): Promise<ProjectDocument | null> => {
    const doc = documents.find(d => d.id === docId);
    const docData = pdfDocuments[docId];
    if (!doc || !docData) return null;

    const markupsByPage = getMarkupsByPage(docId);
    const allMarkups: unknown[] = [];
    Object.entries(markupsByPage).forEach(([page, pageMarkups]) => {
      pageMarkups.forEach((markup) => {
        allMarkups.push({ ...markup, page: parseInt(page, 10) });
      });
    });

    const hasPageEdits = doc.modified;
    const fileSource = docData.pdfSource?.source === 'file' ? docData.pdfSource.path : null;
    let sha256: string;
    let byteLength: number;
    let sourcePath: string | undefined;
    let data: ArrayBuffer | undefined;

    if (fileSource && window.electronAPI?.hashFile && !hasPageEdits) {
      const hashed = await window.electronAPI.hashFile(fileSource);
      if (!hashed.success || !hashed.sha256) return null;
      sha256 = hashed.sha256;
      byteLength = hashed.byteLength || 0;
      sourcePath = fileSource;
    } else {
      const bytes = await getOriginalPdfBytesAsync(docId);
      if (!bytes) return null;
      sha256 = await sha256Hex(bytes);
      byteLength = bytes.byteLength;
      data = bytes;
    }

    if (window.electronAPI?.writeProjectAsset) {
      const written = await window.electronAPI.writeProjectAsset({
        projectPath,
        sha256,
        sourcePath,
        data,
      });
      if (!written.success || !written.relPath || !written.sha256) return null;
      return {
        id: doc.id,
        name: doc.name,
        originalPath: doc.path?.endsWith('.bidveraai') ? undefined : doc.path,
        fileRef: {
          relPath: written.relPath,
          sha256: written.sha256,
          byteLength: written.byteLength ?? byteLength,
        },
        pages: doc.pages,
        currentPage: doc.currentPage,
        zoom: doc.zoom,
        markups: allMarkups,
        measurements: doc.measurements,
      };
    }

    // Browser fallback: cannot write sidecar files; skip PDF bytes (v2 JSON only).
    return {
      id: doc.id,
      name: doc.name,
      originalPath: doc.path,
      fileRef: {
        relPath: `${doc.name}.files/${sha256}.pdf`,
        sha256,
        byteLength,
      },
      pages: doc.pages,
      currentPage: doc.currentPage,
      zoom: doc.zoom,
      markups: allMarkups,
      measurements: doc.measurements,
    };
  }, [documents, pdfDocuments, getMarkupsByPage, getOriginalPdfBytesAsync]);

  const exportDocumentsData = useCallback(async (projectPath: string): Promise<ProjectDocument[]> => {
    const projectDocs: ProjectDocument[] = [];
    for (const doc of documents) {
      if (!pdfDocuments[doc.id]) continue;
      try {
        const exported = await writeAsset(projectPath, doc.id);
        if (exported) projectDocs.push(exported);
      } catch (error) {
        console.error(`Failed to export document ${doc.name}:`, error);
      }
    }
    return projectDocs;
  }, [documents, pdfDocuments, writeAsset]);

  const createProjectData = useCallback(async (projectName: string, projectPath: string): Promise<ProjectFile> => {
    const projectDocs = await exportDocumentsData(projectPath);
    const docIdSet = new Set(projectDocs.map((d) => d.id));
    const productState = useProductStore.getState();
    const currentNodes = productState.nodes;
    const itemSnapshots: Record<string, ProductNode> = {};
    const measurementLinks: Record<string, LinkedMeasurement[]> = {};
    Object.entries(currentNodes).forEach(([id, node]) => {
      if (node.type === 'folder') return;
      const projectMeasurements = (node.measurements || []).filter((measurement) =>
        docIdSet.has(measurement.documentId),
      );
      if (!projectMeasurements.length) return;
      itemSnapshots[id] = { ...node, measurements: [] };
      measurementLinks[id] = projectMeasurements;
    });

    return {
      version: PROJECT_VERSION,
      name: projectName,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      documents: projectDocs,
      catalog: {
        itemSnapshots,
        measurementLinks,
        activeItemId: productState.activeProductId,
      },
      settings: {
        scale,
        scaleUnit,
        snapEnabled,
        gridEnabled,
      },
    };
  }, [exportDocumentsData, nodes, rootIds, scale, scaleUnit, snapEnabled, gridEnabled]);

  const writeProjectJson = useCallback(async (projectPath: string, projectData: ProjectFile) => {
    const jsonData = JSON.stringify(projectData);
    const arrayBuffer = new TextEncoder().encode(jsonData).buffer;
    if (window.electronAPI?.saveFileDirect) {
      return window.electronAPI.saveFileDirect(arrayBuffer, projectPath);
    }
    const blob = new Blob([jsonData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = projectPath.split(/[\\/]/).pop() || `project.${PROJECT_EXTENSION}`;
    a.click();
    URL.revokeObjectURL(url);
    return { success: true, path: projectPath };
  }, []);

  const saveProject = useCallback(async (): Promise<boolean> => {
    const projectPath = getCurrentProjectPath();
    if (!projectPath) return saveProjectAs();

    toast.loading('Saving project...', { id: 'save-project' });
    try {
      const projectName = projectPath.split(/[\\/]/).pop()?.replace('.bidveraai', '') || 'Untitled';
      const projectData = await createProjectData(projectName, projectPath);
      const result = await writeProjectJson(projectPath, projectData);
      if (result.success) {
        documents.forEach(doc => {
          updateDocument(doc.id, { modified: false, path: projectPath, name: projectPath.split(/[\\/]/).pop() || 'Untitled.bidveraai' });
        });
        toast.success('Project saved', { id: 'save-project' });
        return true;
      }
      toast.error('Failed to save project: ' + ('error' in result ? result.error : ''), { id: 'save-project' });
      return false;
    } catch (error) {
      console.error('Failed to save project:', error);
      toast.error('Failed to save project', { id: 'save-project' });
      return false;
    }
  }, [getCurrentProjectPath, createProjectData, writeProjectJson, documents, updateDocument]);

  const saveProjectAs = useCallback(async (): Promise<boolean> => {
    toast.loading('Preparing project...', { id: 'save-project' });
    try {
      const defaultName = documents[0]?.name.replace(/\.pdf$/i, '') || 'Untitled';
      const suggested = `${defaultName}.${PROJECT_EXTENSION}`;
      if (window.electronAPI?.saveFile) {
        const placeholder = new TextEncoder().encode('{}').buffer;
        const picked = await window.electronAPI.saveFile(placeholder, suggested);
        if (picked.canceled || !picked.path) {
          toast.dismiss('save-project');
          return false;
        }
        const projectData = await createProjectData(defaultName, picked.path);
        const result = await writeProjectJson(picked.path, projectData);
        if (result.success) {
          const fileName = picked.path.split(/[\\/]/).pop() || 'Untitled.bidveraai';
          documents.forEach(doc => {
            updateDocument(doc.id, { modified: false, path: picked.path, name: fileName });
          });
          toast.success(`Project saved as "${fileName}"`, { id: 'save-project' });
          return true;
        }
        toast.error('Failed to save project', { id: 'save-project' });
        return false;
      }
      const fakePath = `${dirname(documents[0]?.path || '.')}/${suggested}`;
      const projectData = await createProjectData(defaultName, fakePath);
      await writeProjectJson(suggested, projectData);
      toast.success('Project downloaded', { id: 'save-project' });
      return true;
    } catch (error) {
      console.error('Failed to save project:', error);
      toast.error('Failed to save project', { id: 'save-project' });
      return false;
    }
  }, [documents, createProjectData, writeProjectJson, updateDocument]);

  return {
    saveProject,
    saveProjectAs,
    getCurrentProjectPath,
  };
}
