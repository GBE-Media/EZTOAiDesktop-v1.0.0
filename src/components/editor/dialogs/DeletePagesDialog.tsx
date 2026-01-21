import { useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { deletePages } from '@/lib/pdfManipulation';
import { parsePageRange, validatePageRange, getEvenPages, getOddPages } from '@/lib/pageRangeParser';
import { loadPDF } from '@/lib/pdfLoader';
import { toast } from 'sonner';

interface DeletePagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PageSelection = 'current' | 'range' | 'even' | 'odd';

export function DeletePagesDialog({ open, onOpenChange }: DeletePagesDialogProps) {
  const [pageSelection, setPageSelection] = useState<PageSelection>('current');
  const [pageRange, setPageRange] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  const { 
    activeDocId, 
    getOriginalPdfBytes,
    getCurrentPage,
    getTotalPages,
    setCurrentPage,
  } = useCanvasStore();
  
  const currentPage = getCurrentPage();
  const totalPages = getTotalPages();
  
  // Calculate pages to be deleted for preview
  const getPagesToDelete = useCallback((): number[] => {
    switch (pageSelection) {
      case 'current':
        return [currentPage - 1];
      case 'range':
        return parsePageRange(pageRange, totalPages);
      case 'even':
        return getEvenPages(totalPages);
      case 'odd':
        return getOddPages(totalPages);
      default:
        return [];
    }
  }, [pageSelection, currentPage, pageRange, totalPages]);
  
  const pagesToDelete = getPagesToDelete();
  const remainingPages = totalPages - pagesToDelete.length;
  
  const handleDelete = useCallback(async () => {
    if (!activeDocId) {
      toast.error('No active document');
      return;
    }
    
    // Validate page range if custom selection
    if (pageSelection === 'range') {
      const error = validatePageRange(pageRange, totalPages);
      if (error) {
        toast.error(error);
        return;
      }
    }
    
    // Get page indices to delete
    const pageIndices = getPagesToDelete();
    
    if (pageIndices.length === 0) {
      toast.error('No pages selected to delete');
      return;
    }
    
    // Prevent deleting all pages
    if (pageIndices.length >= totalPages) {
      toast.error('Cannot delete all pages from the document');
      return;
    }
    
    setIsLoading(true);
    
    try {
      const originalBytes = getOriginalPdfBytes();
      if (!originalBytes) {
        toast.error('No document loaded');
        return;
      }
      
      // Check for detached buffer
      if (originalBytes.byteLength === 0) {
        toast.error('PDF data is unavailable. Please reopen the document.');
        console.error('DeletePagesDialog: originalBytes.byteLength is 0 (detached buffer)');
        return;
      }
      
      // Clone buffer BEFORE manipulation to avoid detached buffer issue
      const clonedBytes = originalBytes.slice(0);
      
      const newPdfBytes = await deletePages(clonedBytes, pageIndices);
      
      // Store the new bytes BEFORE passing to loadPDF
      // loadPDF now creates its own copy internally, so newPdfArrayBuffer stays safe
      const newPdfArrayBuffer = newPdfBytes.slice().buffer;
      
      const newPdfDoc = await loadPDF(newPdfArrayBuffer);
      const newTotalPages = newPdfDoc.numPages;
      
      // Verify deletion actually happened
      if (newTotalPages >= totalPages) {
        console.error('DeletePagesDialog: Page count did not decrease', {
          before: totalPages,
          after: newTotalPages,
          pagesToDelete: pageIndices,
        });
        toast.error('Delete operation did not change page count');
        return;
      }
      
      // Get page dimensions from first page
      const page = await newPdfDoc.document.getPage(1);
      const viewport = page.getViewport({ scale: 1.0 });
      
      // Update stores - use updatePdfDocument to preserve markups
      useCanvasStore.getState().updatePdfDocument(
        activeDocId,
        newPdfDoc.document,
        newTotalPages,
        viewport.width,
        viewport.height,
        newPdfArrayBuffer
      );
      
      // Navigate to a valid page if current was deleted
      const newCurrentPage = Math.min(currentPage, newTotalPages);
      setCurrentPage(newCurrentPage);
      
      useEditorStore.getState().updateDocument(activeDocId, { 
        modified: true,
        pages: newTotalPages,
      });
      
      toast.success(`Deleted ${pageIndices.length} page(s)`);
      onOpenChange(false);
      
      // Reset state
      setPageRange('');
    } catch (error) {
      console.error('Failed to delete pages:', error);
      toast.error('Failed to delete pages: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, [
    activeDocId, getOriginalPdfBytes, pageSelection, pageRange,
    totalPages, currentPage, getPagesToDelete, onOpenChange, setCurrentPage
  ]);
  
  const handleClose = () => {
    setPageRange('');
    onOpenChange(false);
  };
  
  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Pages</DialogTitle>
          <DialogDescription>
            Remove pages from the current document.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          {/* Warning */}
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Page deletions cannot be undone with Ctrl+Z. Changes won't be saved until you explicitly save the document.
            </AlertDescription>
          </Alert>
          
          {/* Page Selection */}
          <div className="space-y-2">
            <Label>Pages to Delete</Label>
            <RadioGroup value={pageSelection} onValueChange={(v) => setPageSelection(v as PageSelection)}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="current" id="delete-current" />
                <Label htmlFor="delete-current" className="font-normal">
                  Current page ({currentPage})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="range" id="delete-range" />
                <Label htmlFor="delete-range" className="font-normal">Page range:</Label>
                <Input
                  value={pageRange}
                  onChange={(e) => setPageRange(e.target.value)}
                  placeholder="e.g., 1-5, 8, 10-12"
                  className="w-40 h-8"
                  disabled={pageSelection !== 'range'}
                />
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="even" id="delete-even" />
                <Label htmlFor="delete-even" className="font-normal">
                  Even pages only ({getEvenPages(totalPages).length} pages)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="odd" id="delete-odd" />
                <Label htmlFor="delete-odd" className="font-normal">
                  Odd pages only ({getOddPages(totalPages).length} pages)
                </Label>
              </div>
            </RadioGroup>
          </div>
          
          {/* Preview */}
          <div className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/50">
            <p><strong>Preview:</strong></p>
            <p>
              {pagesToDelete.length > 0
                ? `Will delete ${pagesToDelete.length} page(s): ${pagesToDelete.slice(0, 10).map(i => i + 1).join(', ')}${pagesToDelete.length > 10 ? '...' : ''}`
                : 'No pages selected'}
            </p>
            <p className="mt-1">
              Remaining pages: {remainingPages > 0 ? remainingPages : <span className="text-destructive">0 (invalid)</span>}
            </p>
          </div>
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button 
            variant="destructive"
            onClick={handleDelete} 
            disabled={isLoading || pagesToDelete.length === 0 || remainingPages <= 0}
          >
            {isLoading ? 'Deleting...' : `Delete ${pagesToDelete.length} Page(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
