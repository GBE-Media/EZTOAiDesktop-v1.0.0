import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { exportPdfWithMarkups, downloadPdf } from '@/lib/pdfExport';
import { toast } from 'sonner';
import '@/types/electron.d.ts';

interface SaveAsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SaveAsDialog({ open, onOpenChange }: SaveAsDialogProps) {
  const { documents, activeDocument } = useEditorStore();
  const { getOriginalPdfBytes, getMarkupsByPage } = useCanvasStore();
  
  const currentDoc = documents.find(d => d.id === activeDocument);
  const currentName = currentDoc?.name?.replace(/\.pdf$/i, '') || 'document';
  
  const [filename, setFilename] = useState(currentName);
  const [includeMarkups, setIncludeMarkups] = useState(true);
  const [saving, setSaving] = useState(false);

  // Reset filename when dialog opens
  useEffect(() => {
    if (open) {
      setFilename(currentName);
    }
  }, [open, currentName]);

  const handleSave = async () => {
    if (!currentDoc) {
      toast.error('No document open');
      return;
    }

    const originalBytes = getOriginalPdfBytes();
    if (!originalBytes) {
      toast.error('Original PDF data not available');
      return;
    }

    setSaving(true);
    try {
      const markups = includeMarkups ? getMarkupsByPage() : {};
      const pdfBytes = await exportPdfWithMarkups(originalBytes, markups);
      const finalFilename = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
      
      // Check if running in Electron - use native save dialog
      if (window.electronAPI?.isElectron) {
        // Convert Uint8Array to ArrayBuffer for Electron IPC
        const arrayBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
        const success = await window.electronAPI.saveFile(arrayBuffer, finalFilename);
        if (success) {
          toast.success(`Saved as "${finalFilename}"`);
          onOpenChange(false);
        } else {
          // User cancelled or error - don't show error toast for cancellation
        }
      } else {
        // Fallback to browser download
        downloadPdf(pdfBytes, finalFilename);
        toast.success(`Saved as "${finalFilename}"`);
        onOpenChange(false);
      }
    } catch (error) {
      console.error('Failed to save PDF:', error);
      toast.error('Failed to save PDF');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save As</DialogTitle>
          <DialogDescription>
            Choose a filename for your annotated PDF
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="filename">Filename</Label>
            <div className="flex items-center gap-2">
              <Input
                id="filename"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="Enter filename"
                className="flex-1"
              />
              <span className="text-sm text-muted-foreground">.pdf</span>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="include-markups"
              checked={includeMarkups}
              onCheckedChange={(checked) => setIncludeMarkups(checked === true)}
            />
            <Label htmlFor="include-markups" className="text-sm font-normal cursor-pointer">
              Include markups and annotations
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !filename.trim()}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
