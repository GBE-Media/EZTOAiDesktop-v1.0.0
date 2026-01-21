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
import { RotateCw, RotateCcw } from 'lucide-react';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { rotatePages } from '@/lib/pdfManipulation';
import { parsePageRange, validatePageRange, getAllPages, getEvenPages, getOddPages } from '@/lib/pageRangeParser';
import { loadPDF } from '@/lib/pdfLoader';
import { toast } from 'sonner';

interface RotatePagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PageSelection = 'all' | 'current' | 'range' | 'even' | 'odd';
type RotationDirection = '90' | '180' | '270';

export function RotatePagesDialog({ open, onOpenChange }: RotatePagesDialogProps) {
  const [pageSelection, setPageSelection] = useState<PageSelection>('current');
  const [pageRange, setPageRange] = useState('');
  const [rotation, setRotation] = useState<RotationDirection>('90');
  const [isLoading, setIsLoading] = useState(false);
  
  const { 
    activeDocId, 
    getOriginalPdfBytes,
    getCurrentPage,
    getTotalPages,
  } = useCanvasStore();
  
  const currentPage = getCurrentPage();
  const totalPages = getTotalPages();
  
  const handleRotate = useCallback(async () => {
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
    
    // Get page indices to rotate
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
      case 'even':
        pageIndices = getEvenPages(totalPages);
        break;
      case 'odd':
        pageIndices = getOddPages(totalPages);
        break;
      default:
        pageIndices = [currentPage - 1];
    }
    
    if (pageIndices.length === 0) {
      toast.error('No pages selected to rotate');
      return;
    }
    
    setIsLoading(true);
    
    try {
      const rotationDegrees = parseInt(rotation, 10) as 90 | 180 | 270;
      const newPdfBytes = await rotatePages(originalBytes, pageIndices, rotationDegrees);
      
      // Clone buffer BEFORE passing to loadPDF to avoid detached buffer issue
      const newPdfArrayBuffer = newPdfBytes.slice().buffer;
      
      const newPdfDoc = await loadPDF(newPdfArrayBuffer);
      const newTotalPages = newPdfDoc.numPages;
      
      // Get page dimensions from current page (may have changed due to rotation)
      const page = await newPdfDoc.document.getPage(currentPage);
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
      
      useEditorStore.getState().updateDocument(activeDocId, { 
        modified: true,
      });
      
      const directionText = rotation === '90' ? 'clockwise' : rotation === '270' ? 'counter-clockwise' : '';
      toast.success(`Rotated ${pageIndices.length} page(s) ${rotation}° ${directionText}`);
      onOpenChange(false);
      
      // Reset state
      setPageRange('');
    } catch (error) {
      console.error('Failed to rotate pages:', error);
      toast.error('Failed to rotate pages');
    } finally {
      setIsLoading(false);
    }
  }, [
    activeDocId, getOriginalPdfBytes, pageSelection, pageRange,
    totalPages, currentPage, rotation, onOpenChange
  ]);
  
  const handleClose = () => {
    setPageRange('');
    onOpenChange(false);
  };
  
  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rotate Pages</DialogTitle>
          <DialogDescription>
            Rotate pages in the current document.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 py-4">
          {/* Page Selection */}
          <div className="space-y-2">
            <Label>Pages to Rotate</Label>
            <RadioGroup value={pageSelection} onValueChange={(v) => setPageSelection(v as PageSelection)}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="rotate-all" />
                <Label htmlFor="rotate-all" className="font-normal">
                  All pages ({totalPages})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="current" id="rotate-current" />
                <Label htmlFor="rotate-current" className="font-normal">
                  Current page ({currentPage})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="range" id="rotate-range" />
                <Label htmlFor="rotate-range" className="font-normal">Page range:</Label>
                <Input
                  value={pageRange}
                  onChange={(e) => setPageRange(e.target.value)}
                  placeholder="e.g., 1-5, 8, 10-12"
                  className="w-40 h-8"
                  disabled={pageSelection !== 'range'}
                />
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="even" id="rotate-even" />
                <Label htmlFor="rotate-even" className="font-normal">
                  Even pages only
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="odd" id="rotate-odd" />
                <Label htmlFor="rotate-odd" className="font-normal">
                  Odd pages only
                </Label>
              </div>
            </RadioGroup>
          </div>
          
          {/* Rotation Direction */}
          <div className="space-y-2">
            <Label>Rotation</Label>
            <div className="flex gap-2">
              <Button
                variant={rotation === '90' ? 'default' : 'outline'}
                className="flex-1 gap-2"
                onClick={() => setRotation('90')}
              >
                <RotateCw className="h-4 w-4" />
                90° CW
              </Button>
              <Button
                variant={rotation === '180' ? 'default' : 'outline'}
                className="flex-1"
                onClick={() => setRotation('180')}
              >
                180°
              </Button>
              <Button
                variant={rotation === '270' ? 'default' : 'outline'}
                className="flex-1 gap-2"
                onClick={() => setRotation('270')}
              >
                <RotateCcw className="h-4 w-4" />
                90° CCW
              </Button>
            </div>
          </div>
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleRotate} 
            disabled={isLoading}
          >
            {isLoading ? 'Rotating...' : 'Rotate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
