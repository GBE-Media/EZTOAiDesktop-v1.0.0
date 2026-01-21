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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { insertPages, insertBlankPage, getPageCount, PAGE_SIZES, PageSizeName } from '@/lib/pdfManipulation';
import { parsePageRange, validatePageRange, getAllPages } from '@/lib/pageRangeParser';
import { loadPDF } from '@/lib/pdfLoader';
import { toast } from 'sonner';

interface InsertPagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PageSelection = 'all' | 'range';
type InsertLocation = 'before-current' | 'after-current' | 'beginning' | 'end' | 'before-page' | 'after-page';
type InsertMode = 'pdf' | 'blank';

export function InsertPagesDialog({ open, onOpenChange }: InsertPagesDialogProps) {
  const [insertMode, setInsertMode] = useState<InsertMode>('pdf');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourcePageCount, setSourcePageCount] = useState(0);
  const [pageSelection, setPageSelection] = useState<PageSelection>('all');
  const [pageRange, setPageRange] = useState('');
  const [insertLocation, setInsertLocation] = useState<InsertLocation>('after-current');
  const [insertPage, setInsertPage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  // Blank page options
  const [blankPageSize, setBlankPageSize] = useState<PageSizeName | 'current'>('Letter');
  const [blankPageCount, setBlankPageCount] = useState(1);
  
  const { 
    activeDocId, 
    pdfDocuments, 
    getOriginalPdfBytes,
    getCurrentPage,
    getTotalPages,
  } = useCanvasStore();
  
  const currentPage = getCurrentPage();
  const totalPages = getTotalPages();
  
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Please select a valid PDF file');
      return;
    }
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pageCount = await getPageCount(arrayBuffer);
      setSourceFile(file);
      setSourcePageCount(pageCount);
      setPageRange(`1-${pageCount}`);
    } catch (error) {
      console.error('Failed to read source PDF:', error);
      toast.error('Failed to read the selected PDF file');
    }
  }, []);
  
  const getInsertIndex = useCallback(() => {
    switch (insertLocation) {
      case 'beginning':
        return 0;
      case 'end':
        return totalPages;
      case 'before-current':
        return currentPage - 1;
      case 'after-current':
        return currentPage;
      case 'before-page':
        return Math.max(0, parseInt(insertPage, 10) - 1);
      case 'after-page':
        return Math.min(totalPages, parseInt(insertPage, 10));
      default:
        return currentPage;
    }
  }, [insertLocation, insertPage, currentPage, totalPages]);
  
  const handleInsertFromPdf = useCallback(async () => {
    if (!activeDocId) {
      toast.error('No document loaded');
      return;
    }
    if (!sourceFile) return;
    
    const originalBytes = getOriginalPdfBytes();
    if (!originalBytes) {
      toast.error('No document loaded');
      return;
    }
    
    // Validate page range if custom selection
    if (pageSelection === 'range') {
      const error = validatePageRange(pageRange, sourcePageCount);
      if (error) {
        toast.error(error);
        return;
      }
    }
    
    const insertAtIndex = getInsertIndex();
    
    // Get source page indices
    const sourcePageIndices = pageSelection === 'all'
      ? getAllPages(sourcePageCount)
      : parsePageRange(pageRange, sourcePageCount);
    
    if (sourcePageIndices.length === 0) {
      toast.error('No pages selected to insert');
      return;
    }
    
    setIsLoading(true);
    
    try {
      const sourceBytes = await sourceFile.arrayBuffer();
      const newPdfBytes = await insertPages(
        originalBytes,
        sourceBytes,
        insertAtIndex,
        sourcePageIndices
      );
      
      // Clone buffer BEFORE passing to loadPDF to avoid detached buffer issue
      const newPdfArrayBuffer = newPdfBytes.slice().buffer;
      
      // Reload the document with new bytes
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
      
      useEditorStore.getState().updateDocument(activeDocId, { 
        modified: true,
        pages: newTotalPages,
      });
      
      toast.success(`Inserted ${sourcePageIndices.length} page(s)`);
      onOpenChange(false);
      resetState();
    } catch (error) {
      console.error('Failed to insert pages:', error);
      toast.error('Failed to insert pages');
    } finally {
      setIsLoading(false);
    }
  }, [
    sourceFile, activeDocId, getOriginalPdfBytes, pageSelection, pageRange,
    sourcePageCount, getInsertIndex, onOpenChange
  ]);
  
  const handleInsertBlankPage = useCallback(async () => {
    if (!activeDocId) {
      toast.error('No document loaded');
      return;
    }
    
    const originalBytes = getOriginalPdfBytes();
    if (!originalBytes) {
      toast.error('No document loaded');
      return;
    }
    
    const insertAtIndex = getInsertIndex();
    
    // Determine page size
    let pageSize: [number, number];
    if (blankPageSize === 'current') {
      // Get current page dimensions from pdfDocuments
      const docData = pdfDocuments[activeDocId];
      if (docData) {
        pageSize = [docData.originalPageWidth, docData.originalPageHeight];
      } else {
        pageSize = PAGE_SIZES['Letter'];
      }
    } else {
      pageSize = PAGE_SIZES[blankPageSize];
    }
    
    setIsLoading(true);
    
    try {
      const newPdfBytes = await insertBlankPage(
        originalBytes,
        insertAtIndex,
        pageSize,
        blankPageCount
      );
      
      // Clone buffer BEFORE passing to loadPDF
      const newPdfArrayBuffer = newPdfBytes.slice().buffer;
      
      // Reload the document with new bytes
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
      
      useEditorStore.getState().updateDocument(activeDocId, { 
        modified: true,
        pages: newTotalPages,
      });
      
      toast.success(`Inserted ${blankPageCount} blank page(s)`);
      onOpenChange(false);
      resetState();
    } catch (error) {
      console.error('Failed to insert blank page:', error);
      toast.error('Failed to insert blank page');
    } finally {
      setIsLoading(false);
    }
  }, [
    activeDocId, getOriginalPdfBytes, getInsertIndex, blankPageSize, 
    blankPageCount, pdfDocuments, onOpenChange
  ]);
  
  const handleInsert = useCallback(() => {
    if (insertMode === 'pdf') {
      handleInsertFromPdf();
    } else {
      handleInsertBlankPage();
    }
  }, [insertMode, handleInsertFromPdf, handleInsertBlankPage]);
  
  const resetState = () => {
    setSourceFile(null);
    setSourcePageCount(0);
    setPageRange('');
    setInsertPage('');
    setBlankPageCount(1);
  };
  
  const handleClose = () => {
    resetState();
    onOpenChange(false);
  };
  
  const canInsert = activeDocId && (insertMode === 'pdf' ? !!sourceFile : blankPageCount > 0);
  
  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Insert Pages</DialogTitle>
          <DialogDescription>
            Insert pages from another PDF or add blank pages.
          </DialogDescription>
        </DialogHeader>
        
        <Tabs value={insertMode} onValueChange={(v) => setInsertMode(v as InsertMode)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="pdf">From PDF</TabsTrigger>
            <TabsTrigger value="blank">Blank Page</TabsTrigger>
          </TabsList>
          
          <TabsContent value="pdf" className="space-y-4 mt-4">
            {/* Source File Selection */}
            <div className="space-y-2">
              <Label htmlFor="source-file">Source PDF</Label>
              <Input
                id="source-file"
                type="file"
                accept=".pdf"
                onChange={handleFileSelect}
                className="cursor-pointer"
              />
              {sourceFile && (
                <p className="text-xs text-muted-foreground">
                  {sourceFile.name} ({sourcePageCount} pages)
                </p>
              )}
            </div>
            
            {/* Page Selection */}
            {sourceFile && (
              <div className="space-y-2">
                <Label>Pages to Insert</Label>
                <RadioGroup value={pageSelection} onValueChange={(v) => setPageSelection(v as PageSelection)}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="all" id="all-pages" />
                    <Label htmlFor="all-pages" className="font-normal">All pages</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="range" id="page-range" />
                    <Label htmlFor="page-range" className="font-normal">Page range:</Label>
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
            )}
          </TabsContent>
          
          <TabsContent value="blank" className="space-y-4 mt-4">
            {/* Page Size */}
            <div className="space-y-2">
              <Label>Page Size</Label>
              <Select value={blankPageSize} onValueChange={(v) => setBlankPageSize(v as PageSizeName | 'current')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">Same as Current Page</SelectItem>
                  <SelectItem value="Letter">Letter (8.5" × 11")</SelectItem>
                  <SelectItem value="Legal">Legal (8.5" × 14")</SelectItem>
                  <SelectItem value="Tabloid">Tabloid (11" × 17")</SelectItem>
                  <SelectItem value="A3">A3 (297mm × 420mm)</SelectItem>
                  <SelectItem value="A4">A4 (210mm × 297mm)</SelectItem>
                  <SelectItem value="A5">A5 (148mm × 210mm)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {/* Number of Pages */}
            <div className="space-y-2">
              <Label>Number of Pages</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={blankPageCount}
                onChange={(e) => setBlankPageCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
                className="w-24"
              />
            </div>
          </TabsContent>
        </Tabs>
        
        {/* Insert Location - shared between both tabs */}
        <div className="space-y-2 pt-2">
          <Label>Insert Location</Label>
          <RadioGroup value={insertLocation} onValueChange={(v) => setInsertLocation(v as InsertLocation)}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="before-current" id="before-current" />
              <Label htmlFor="before-current" className="font-normal">
                Before current page ({currentPage})
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="after-current" id="after-current" />
              <Label htmlFor="after-current" className="font-normal">
                After current page ({currentPage})
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="beginning" id="beginning" />
              <Label htmlFor="beginning" className="font-normal">At the beginning</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="end" id="end" />
              <Label htmlFor="end" className="font-normal">At the end</Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="before-page" id="before-page" />
              <Label htmlFor="before-page" className="font-normal">Before page:</Label>
              <Input
                type="number"
                min={1}
                max={totalPages}
                value={insertPage}
                onChange={(e) => setInsertPage(e.target.value)}
                className="w-20 h-8"
                disabled={insertLocation !== 'before-page'}
              />
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="after-page" id="after-page" />
              <Label htmlFor="after-page" className="font-normal">After page:</Label>
              <Input
                type="number"
                min={1}
                max={totalPages}
                value={insertPage}
                onChange={(e) => setInsertPage(e.target.value)}
                className="w-20 h-8"
                disabled={insertLocation !== 'after-page'}
              />
            </div>
          </RadioGroup>
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleInsert} 
            disabled={!canInsert || isLoading}
          >
            {isLoading ? 'Inserting...' : 'Insert'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
