import { useState, useRef } from 'react';
import { X, FileText, Plus } from 'lucide-react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useFileOpen } from '@/hooks/useFileOpen';
import { useSave } from '@/hooks/useSave';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import type { Document } from '@/types/editor';

export function DocumentTabs() {
  const { documents, activeDocument, setActiveDocument, closeDocument, reorderDocuments } = useEditorStore();
  const { removeDocument, setActiveDocId } = useCanvasStore();
  const { triggerFileDialog } = useFileOpen();
  const { save } = useSave();
  
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  
  // Unsaved changes dialog state
  const [pendingCloseDoc, setPendingCloseDoc] = useState<Document | null>(null);
  
  // Handle tab click - sync BOTH stores immediately to prevent timing issues
  const handleTabClick = (docId: string) => {
    setActiveDocId(docId);        // Canvas store - immediate
    setActiveDocument(docId);     // Editor store - immediate
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    dragRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragRef.current !== null && dragRef.current !== index) {
      setDropTargetIndex(index);
    }
  };

  const handleDragLeave = () => {
    setDropTargetIndex(null);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = dragRef.current;
    if (fromIndex !== null && fromIndex !== toIndex) {
      reorderDocuments(fromIndex, toIndex);
    }
    setDraggedIndex(null);
    setDropTargetIndex(null);
    dragRef.current = null;
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDropTargetIndex(null);
    dragRef.current = null;
  };

  const handleCloseClick = (e: React.MouseEvent, doc: Document) => {
    e.stopPropagation();
    e.preventDefault();
    
    console.log('[DocumentTabs] Close button clicked for:', doc.name, doc.id);
    
    if (doc.modified) {
      // Show confirmation dialog
      console.log('[DocumentTabs] Document modified, showing dialog');
      setPendingCloseDoc(doc);
    } else {
      // Close immediately
      console.log('[DocumentTabs] Closing document immediately');
      removeDocument(doc.id);
      closeDocument(doc.id);
    }
  };

  const handleSaveAndClose = async () => {
    if (!pendingCloseDoc) return;
    
    const success = await save(pendingCloseDoc.id);
    if (success) {
      removeDocument(pendingCloseDoc.id);
      closeDocument(pendingCloseDoc.id);
    }
    setPendingCloseDoc(null);
  };

  const handleDiscardAndClose = () => {
    if (!pendingCloseDoc) return;
    removeDocument(pendingCloseDoc.id);
    closeDocument(pendingCloseDoc.id);
    setPendingCloseDoc(null);
  };

  const handleCancelClose = () => {
    setPendingCloseDoc(null);
  };

  return (
    <>
      <div className="flex items-center h-9 bg-panel border-b border-panel-border overflow-hidden">
        {documents.map((doc, index) => {
          const isActive = doc.id === activeDocument;
          const isDragging = draggedIndex === index;
          const isDropTarget = dropTargetIndex === index;
          
          return (
            <div
              key={doc.id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              className={`
                doc-tab group relative cursor-grab active:cursor-grabbing
                ${isActive ? 'active' : ''}
                ${isDragging ? 'opacity-50' : ''}
                ${isDropTarget ? 'before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:bg-primary before:rounded-full' : ''}
            `}
              onClick={() => handleTabClick(doc.id)}
            >
              <FileText className={`w-3.5 h-3.5 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className={`truncate max-w-[150px] ${isActive ? 'text-foreground font-medium' : ''}`}>
                {doc.name}{doc.modified ? ' *' : ''}
              </span>
              <button
                className="w-4 h-4 rounded-sm flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-destructive/20 transition-opacity pointer-events-auto"
                onClick={(e) => handleCloseClick(e, doc)}
                title="Close document"
              >
                <X className="w-3 h-3" />
              </button>
              {/* Active indicator bar */}
              {isActive && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </div>
          );
        })}
        
        {/* New tab button - opens file dialog */}
        <button 
          className="flex items-center justify-center w-8 h-full text-muted-foreground hover:bg-secondary hover:text-foreground"
          onClick={triggerFileDialog}
          title="Open PDF (Ctrl+O)"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Unsaved changes confirmation dialog */}
      <UnsavedChangesDialog
        open={!!pendingCloseDoc}
        documentName={pendingCloseDoc?.name || ''}
        onSave={handleSaveAndClose}
        onDiscard={handleDiscardAndClose}
        onCancel={handleCancelClose}
      />
    </>
  );
}
