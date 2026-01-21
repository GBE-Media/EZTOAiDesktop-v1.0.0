import { useEffect, useState } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useProjectSave } from '@/hooks/useProjectSave';

export function useWindowClose() {
  const { documents } = useEditorStore();
  const { saveProject } = useProjectSave();
  const [showDialog, setShowDialog] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.onCheckUnsavedChanges) return;

    const cleanup = window.electronAPI.onCheckUnsavedChanges(() => {
      // Check if any documents have unsaved changes
      const unsavedDocs = documents.filter(doc => doc.modified);
      
      if (unsavedDocs.length > 0) {
        // Show unsaved changes dialog
        setPendingClose(true);
        setShowDialog(true);
      } else {
        // No unsaved changes, allow close
        window.electronAPI?.confirmClose();
      }
    });

    return cleanup;
  }, [documents]);

  const handleSaveAndClose = async () => {
    // Save the entire project
    const success = await saveProject();
    
    if (!success) {
      // If save failed or was canceled, don't close
      setShowDialog(false);
      setPendingClose(false);
      window.electronAPI?.cancelClose();
      return;
    }
    
    // Saved successfully, close window
    setShowDialog(false);
    setPendingClose(false);
    window.electronAPI?.confirmClose();
  };

  const handleDiscardAndClose = () => {
    // Discard changes and close
    setShowDialog(false);
    setPendingClose(false);
    window.electronAPI?.confirmClose();
  };

  const handleCancelClose = () => {
    // Cancel close operation
    setShowDialog(false);
    setPendingClose(false);
    window.electronAPI?.cancelClose();
  };

  return {
    showUnsavedDialog: showDialog,
    unsavedDocuments: documents.filter(doc => doc.modified),
    onSaveAndClose: handleSaveAndClose,
    onDiscardAndClose: handleDiscardAndClose,
    onCancelClose: handleCancelClose,
  };
}
