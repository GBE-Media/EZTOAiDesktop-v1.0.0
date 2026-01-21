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
import { Checkbox } from '@/components/ui/checkbox';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { extractPages, deletePages } from '@/lib/pdfManipulation';
import { parsePageRange, validatePageRange, getAllPages } from '@/lib/pageRangeParser';
import { loadPDF } from '@/lib/pdfLoader';
import { downloadPdf } from '@/lib/pdfExport';
import { toast } from 'sonner';

interface ExtractPagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PageSelection = 'all' | 'current' | 'range';

export function ExtractPagesDialog({ open, onOpenChange }: ExtractPagesDialogProps) {
  const [pageSelection, setPageSelection] = useState<PageSelection>('current');
  const [pageRange, setPageRange] = useState('');
  const [deleteAfterExtract, setDeleteAfterExtract] = useState(false);
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
  
  const handleExtract = useCallback(async () => {
    if (!activeDocId) return;
    
    const originalBytes = getOriginalPdfBytes();
    if (!originalBytes) {
      toast.error('No document loaded');
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
    
    // Get page indices to extract
    let pageIndices: number[];
    switch (pageSelection) {
      case 'all':
        pageIndices = getAllPages(totalPages);
        break;
      case 'current':
        pageIndices = [currentPage - 1];
        break;
      case 'range':
        pageIndices = parsePageRange(pageRange, totalPages);
        break;
      default:
        pageIndices = [currentPage - 1];
    }
    
    if (pageIndices.length === 0) {
      toast.error('No pages selected to extract');
      return;
    }
    
    // Prevent extracting all pages with delete option
    if (deleteAfterExtract && pageIndices.length === totalPages) {
      toast.error('Cannot delete all pages from the document');
      return;
    }
    
    setIsLoading(true);
    
    try {
      // Extract pages to new PDF
      const extractedBytes = await extractPages(originalBytes, pageIndices);
      
      // Generate filename
      const currentDoc = useEditorStore.getState().documents.find(d => d.id === activeDocId);
      const baseName = currentDoc?.name?.replace('.pdf', '') || 'extracted';
      const fileName = `${baseName}_pages_${pageIndices.map(i => i + 1).join('-')}.pdf`;
      
      // Trigger download (or save dialog in Electron)
      if (window.electronAPI?.saveFile) {
        const result = await window.electronAPI.saveFile(extractedBytes.buffer as ArrayBuffer, fileName);
        if (result.success) {
          toast.success(`Extracted ${pageIndices.length} page(s) to ${result.path}`);
        }
      } else {
        downloadPdf(extractedBytes, fileName);
        toast.success(`Extracted ${pageIndices.length} page(s)`);
      }
      
      // Delete pages from original if requested
      if (deleteAfterExtract) {
        const newPdfBytes = await deletePages(originalBytes, pageIndices);
        
        // Clone buffer BEFORE passing to loadPDF to avoid detached buffer issue
        const newPdfArrayBuffer = newPdfBytes.slice().buffer;
        
        const newPdfDoc = await loadPDF(newPdfArrayBuffer);
        const newTotalPages = newPdfDoc.numPages;
        
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
        
        toast.info(`Deleted ${pageIndices.length} page(s) from original`);
      }
      
      onOpenChange(false);
      
      // Reset state
      setPageRange('');
      setDeleteAfterExtract(false);
    } catch (error) {
      console.error('Failed to extract pages:', error);
      toast.error('Failed to extract pages');
    } finally {
      setIsLoading(false);
    }
  }, [
    activeDocId, getOriginalPdfBytes, pageSelection, pageRange,
    totalPages, currentPage, deleteAfterExtract, onOpenChange, setCurrentPage
  ]);
  
  const handleClose = () => {
    setPageRange('');
    setDeleteAfterExtract(false);
    onOpenChange(false);
  };
  
  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Extract Pages</DialogTitle>
          <DialogDescription>
            Extract pages to a new PDF file.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          {/* Page Selection */}
          <div className="space-y-2">
            <Label>Pages to Extract</Label>
            <RadioGroup value={pageSelection} onValueChange={(v) => setPageSelection(v as PageSelection)}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="extract-all" />
                <Label htmlFor="extract-all" className="font-normal">
                  All pages ({totalPages})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="current" id="extract-current" />
                <Label htmlFor="extract-current" className="font-normal">
                  Current page ({currentPage})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="range" id="extract-range" />
                <Label htmlFor="extract-range" className="font-normal">Page range:</Label>
                <Input
                  value={pageRange}
                  onChange={(e) => setPageRange(e.target.value)}
                  placeholder="e.g., 1-5, 8, 10-12"
                  className="w-40 h-8"
                  disabled={pageSelection !== 'range'}
                />
              </div>
            </RadioGroup>
          </div>
          
          {/* Options */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="delete-after"
              checked={deleteAfterExtract}
              onCheckedChange={(checked) => setDeleteAfterExtract(checked === true)}
            />
            <Label htmlFor="delete-after" className="font-normal text-sm">
              Delete pages after extracting
            </Label>
          </div>
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleExtract} 
            disabled={isLoading}
          >
            {isLoading ? 'Extracting...' : 'Extract'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
