import { useCallback, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { useFileOpen } from '@/hooks/useFileOpen';
import { useProjectSave } from '@/hooks/useProjectSave';
import { useProjectOpen } from '@/hooks/useProjectOpen';
import { printDocument } from '@/lib/pdfPrint';
import { getWordsFromTextItems, getTextContentWithBounds, renderPageForOcr } from '@/lib/pdfLoader';
import { performOcr, isScannedDocument } from '@/lib/ocrEngine';
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { OcrDialog } from './OcrDialog';
import { InsertPagesDialog } from './dialogs/InsertPagesDialog';
import { ExtractPagesDialog } from './dialogs/ExtractPagesDialog';
import { DeletePagesDialog } from './dialogs/DeletePagesDialog';
import { RotatePagesDialog } from './dialogs/RotatePagesDialog';
import { UserMenu } from '@/components/auth/UserMenu';
import { toast } from 'sonner';

export function MenuBar() {
  const [ocrDialogOpen, setOcrDialogOpen] = useState(false);
  const [insertPagesOpen, setInsertPagesOpen] = useState(false);
  const [extractPagesOpen, setExtractPagesOpen] = useState(false);
  const [deletePagesOpen, setDeletePagesOpen] = useState(false);
  const [rotatePagesOpen, setRotatePagesOpen] = useState(false);
  const { triggerFileDialog } = useFileOpen();
  const { saveProject, saveProjectAs } = useProjectSave();
  const { openProjectFile } = useProjectOpen();
  const { clearProductCounts } = useProductStore();
  const { 
    documents, 
    activeDocument, 
    gridEnabled, 
    snapEnabled,
    toggleGrid, 
    toggleSnap,
    setActiveTool,
    closeDocument,
  } = useEditorStore();
  
  const { 
    pdfDocuments,
    activeDocId,
    zoom, 
    setZoom,
    startCalibration,
    getOriginalPdfBytes,
    getMarkupsByPage,
    setCurrentPage,
    getPdfDocument,
    getOcrStatus,
    setOcrStatus,
    setTextContent,
    setTextWords,
    removeDocument,
  } = useCanvasStore();

  // Derive page info from document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const currentPage = currentDocData?.currentPage || 1;
  const totalPages = currentDocData?.totalPages || 0;

  const currentDoc = documents.find(d => d.id === activeDocument);

  // File menu actions
  const handleNew = useCallback(() => {
    // Clear product counts for new estimate
    clearProductCounts();
    
    // Close all documents
    documents.forEach(doc => {
      removeDocument(doc.id);
      closeDocument(doc.id);
    });
    
    toast.success('New estimate started - product counts cleared');
  }, [clearProductCounts, documents, removeDocument, closeDocument]);

  const handleOpenProject = useCallback(() => {
    openProjectFile();
  }, [openProjectFile]);

  const handleImportPDF = useCallback(() => {
    triggerFileDialog();
  }, [triggerFileDialog]);

  const handleSave = useCallback(async () => {
    await saveProject();
  }, [saveProject]);

  const handleSaveAs = useCallback(async () => {
    await saveProjectAs();
  }, [saveProjectAs]);

  const handlePrint = useCallback(async () => {
    const pdfDocument = getPdfDocument();
    const markupsByPage = getMarkupsByPage();
    
    if (!pdfDocument) {
      toast.error('No document to print');
      return;
    }
    
    try {
      toast.loading('Preparing document for print...', { id: 'print-pdf' });
      await printDocument(pdfDocument, markupsByPage);
      toast.success('Print dialog opened', { id: 'print-pdf' });
    } catch (error) {
      console.error('Failed to print:', error);
      toast.error('Failed to print document', { id: 'print-pdf' });
    }
  }, [getPdfDocument, getMarkupsByPage]);

  const handleExport = useCallback(async () => {
    // Export current PDF with markups
    const doc = documents.find(d => d.id === activeDocument);
    if (!doc) return;

    const originalBytes = getOriginalPdfBytes();
    const markupsByPage = getMarkupsByPage();

    if (!originalBytes) {
      toast.error('No PDF data available');
      return;
    }

    try {
      toast.loading('Exporting PDF...', { id: 'export-pdf' });
      const { exportPdfWithMarkups } = await import('@/lib/pdfExport');
      const pdfBytes = await exportPdfWithMarkups(originalBytes, markupsByPage);
      
      // Convert to ArrayBuffer
      const arrayBuffer = new ArrayBuffer(pdfBytes.byteLength);
      new Uint8Array(arrayBuffer).set(pdfBytes);

      if (window.electronAPI?.isElectron) {
        const result = await window.electronAPI.saveFile(arrayBuffer, doc.name);
        if (result.success) {
          toast.success(`Exported as "${result.name}"`, { id: 'export-pdf' });
        } else if (!result.canceled) {
          toast.error('Failed to export', { id: 'export-pdf' });
        } else {
          toast.dismiss('export-pdf');
        }
      } else {
        // Browser fallback
        const { downloadPdf } = await import('@/lib/pdfExport');
        downloadPdf(pdfBytes, doc.name);
        toast.success('Downloaded', { id: 'export-pdf' });
      }
    } catch (error) {
      console.error('Export failed:', error);
      toast.error('Failed to export PDF', { id: 'export-pdf' });
    }
  }, [documents, activeDocument, getOriginalPdfBytes, getMarkupsByPage]);
  
  const handleClose = useCallback(() => {
    if (activeDocument) {
      removeDocument(activeDocument); // Clear from canvas store first
      closeDocument(activeDocument);  // Then remove from editor store
    }
  }, [activeDocument, closeDocument, removeDocument]);

  // Edit menu actions
  const handleUndo = useCallback(() => {
    toast.info('Undo');
  }, []);

  const handleRedo = useCallback(() => {
    toast.info('Redo');
  }, []);

  const handleCut = useCallback(() => {
    document.execCommand('cut');
  }, []);

  const handleCopy = useCallback(() => {
    document.execCommand('copy');
  }, []);

  const handlePaste = useCallback(() => {
    document.execCommand('paste');
  }, []);

  const handleSelectAll = useCallback(() => {
    toast.info('Select All');
  }, []);

  const handleDelete = useCallback(() => {
    toast.info('Delete selected items');
  }, []);

  // View menu actions
  const handleZoomIn = useCallback(() => {
    setZoom(Math.min(zoom + 25, 400));
  }, [zoom, setZoom]);

  const handleZoomOut = useCallback(() => {
    setZoom(Math.max(zoom - 25, 25));
  }, [zoom, setZoom]);

  const handleFitPage = useCallback(() => {
    setZoom(100);
  }, [setZoom]);

  const handleFitWidth = useCallback(() => {
    setZoom(125);
  }, [setZoom]);

  const handleRotateCW = useCallback(() => {
    toast.info('Rotate Clockwise');
  }, []);

  const handleRotateCCW = useCallback(() => {
    toast.info('Rotate Counter-Clockwise');
  }, []);

  // Markup menu actions
  const handleToolSelect = useCallback((tool: string) => {
    setActiveTool(tool as any);
    toast.info(`${tool} tool selected`);
  }, [setActiveTool]);

  // Measure menu actions
  const handleCalibrateScale = useCallback(() => {
    startCalibration();
    toast.info('Click two points to set scale');
  }, [startCalibration]);

  // Document menu actions
  const handleInsertPages = useCallback(() => {
    setInsertPagesOpen(true);
  }, []);

  const handleExtractPages = useCallback(() => {
    setExtractPagesOpen(true);
  }, []);

  const handleDeletePages = useCallback(() => {
    setDeletePagesOpen(true);
  }, []);

  const handleRotatePages = useCallback(() => {
    setRotatePagesOpen(true);
  }, []);


  const handlePageLabels = useCallback(() => {
    toast.info('Page Labels dialog would open');
  }, []);

  // OCR handler - now takes page range and uses Tesseract.js for scanned documents
  const handleRunOcr = useCallback(async (pageRange: number[]) => {
    const pdfDoc = getPdfDocument();
    if (!pdfDoc || pageRange.length === 0) return;
    
    setOcrStatus('running', 0);
    const renderScale = 1.5;
    
    try {
      for (let i = 0; i < pageRange.length; i++) {
        const pageNum = pageRange[i];
        
        // Step 1: Try PDF.js text extraction first (fast, for PDFs with embedded text)
        let textItems = await getTextContentWithBounds(pdfDoc, pageNum, renderScale);
        
        // Check if this appears to be a scanned document (very little text)
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const pageArea = viewport.width * viewport.height;
        
        if (textItems.length === 0 || isScannedDocument(textItems.length, pageArea)) {
          // Step 2: Fall back to Tesseract.js OCR for scanned pages
          console.log(`Page ${pageNum}: Using Tesseract.js OCR (scanned document detected)`);
          
          // Render page at 300 DPI for better OCR accuracy
          const ocrCanvas = await renderPageForOcr(pdfDoc, pageNum, 300);
          
          // Perform OCR with progress tracking
          const ocrResult = await performOcr(ocrCanvas, (ocrProgress) => {
            // Sub-progress within the page
            const pageProgress = (i / pageRange.length) * 100;
            const subProgress = (ocrProgress / 100) * (100 / pageRange.length);
            setOcrStatus('running', Math.round(pageProgress + subProgress * 0.9));
          });
          
          // Scale OCR word positions from 300 DPI back to render scale
          const dpiScale = renderScale / (300 / 72);
          textItems = ocrResult.words.map((w) => ({
            str: w.text,
            x: w.x * dpiScale,
            y: w.y * dpiScale,
            width: w.width * dpiScale,
            height: w.height * dpiScale,
          }));
          
          console.log(`Page ${pageNum}: OCR extracted ${textItems.length} words with ${ocrResult.confidence.toFixed(1)}% confidence`);
        } else {
          console.log(`Page ${pageNum}: Using PDF.js text extraction (${textItems.length} items)`);
        }
        
        // Store text content
        setTextContent(pageNum, textItems);
        
        // Convert to word-level data for professional highlighting
        const words = getWordsFromTextItems(textItems);
        setTextWords(pageNum, words);
        
        // Update progress
        const progress = Math.round(((i + 1) / pageRange.length) * 100);
        setOcrStatus('running', progress);
      }
      
      setOcrStatus('completed', 100);
      toast.success(`OCR completed for ${pageRange.length} page(s)`);
    } catch (error) {
      console.error('OCR failed:', error);
      setOcrStatus('failed', 0);
      toast.error('Failed to extract text');
    }
  }, [getPdfDocument, setTextContent, setTextWords, setOcrStatus]);

  // Open OCR dialog
  const handleOpenOcrDialog = useCallback(() => {
    setOcrDialogOpen(true);
  }, []);

  const ocrStatus = getOcrStatus();

  const handleNextPage = useCallback(() => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
    }
  }, [currentPage, totalPages, setCurrentPage]);

  const handlePrevPage = useCallback(() => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  }, [currentPage, setCurrentPage]);

  // Window menu state
  const handleResetLayout = useCallback(() => {
    toast.info('Layout reset to default');
  }, []);

  // Help menu actions
  const handleDocumentation = useCallback(() => {
    window.open('https://docs.ezto.ai', '_blank');
  }, []);

  const handleKeyboardShortcuts = useCallback(() => {
    toast.info(
      'Keyboard Shortcuts: V-Select, H-Pan, R-Rectangle, E-Ellipse, L-Line, A-Arrow, M-Measure, C-Cloud, T-Text'
    );
  }, []);

  const handleAbout = useCallback(async () => {
    const version = window.electronAPI?.getAppVersion 
      ? await window.electronAPI.getAppVersion() 
      : '1.0.0';
    toast.info(`EZTO Ai Desktop v${version} - Professional PDF Editor`);
  }, []);

  // Window control handlers
  const handleWindowMinimize = useCallback(() => {
    window.electronAPI?.windowMinimize();
  }, []);

  const handleWindowMaximize = useCallback(() => {
    window.electronAPI?.windowMaximize();
  }, []);

  const handleWindowClose = useCallback(() => {
    window.electronAPI?.windowClose();
  }, []);

  // CSS for app region drag
  const dragStyle = { WebkitAppRegion: 'drag' } as unknown as React.CSSProperties;
  const noDragStyle = { WebkitAppRegion: 'no-drag' } as unknown as React.CSSProperties;

  return (
    <div 
      className="flex items-center h-8 bg-panel-header border-b border-panel-border px-1"
      style={dragStyle}
    >
      {/* Logo - no-drag for click events */}
      <div className="flex items-center gap-1.5 px-2 mr-2" style={noDragStyle}>
        <img 
          src="/logo.png" 
          alt="EZTO Ai" 
          className="h-5 w-auto object-contain"
        />
        <span className="text-xs font-semibold text-foreground">EZTO Ai</span>
      </div>

      <Menubar className="border-none bg-transparent h-auto p-0 space-x-0" style={noDragStyle}>
        {/* File Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            File
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs" onClick={handleNew}>
              New <MenubarShortcut>Ctrl+N</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleOpenProject}>
              Open Project... <MenubarShortcut>Ctrl+O</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleImportPDF}>
              Import PDF...
            </MenubarItem>
            <MenubarItem className="text-xs" disabled>Open Recent</MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleSave} disabled={!currentDoc}>
              Save Project <MenubarShortcut>Ctrl+S</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleSaveAs} disabled={!currentDoc}>
              Save Project As... <MenubarShortcut>Ctrl+Shift+S</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handlePrint}>
              Print... <MenubarShortcut>Ctrl+P</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleExport} disabled={!currentDoc}>
              Export...
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleClose} disabled={!currentDoc}>
              Close
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* Edit Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            Edit
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs" onClick={handleUndo}>
              Undo <MenubarShortcut>Ctrl+Z</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleRedo}>
              Redo <MenubarShortcut>Ctrl+Y</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleCut}>
              Cut <MenubarShortcut>Ctrl+X</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleCopy}>
              Copy <MenubarShortcut>Ctrl+C</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handlePaste}>
              Paste <MenubarShortcut>Ctrl+V</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleSelectAll}>
              Select All <MenubarShortcut>Ctrl+A</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleDelete}>
              Delete <MenubarShortcut>Del</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* View Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            View
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs" onClick={handleZoomIn}>
              Zoom In <MenubarShortcut>Ctrl++</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleZoomOut}>
              Zoom Out <MenubarShortcut>Ctrl+-</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleFitPage}>
              Fit Page <MenubarShortcut>Ctrl+0</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleFitWidth}>
              Fit Width
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleRotateCW}>
              Rotate Clockwise
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleRotateCCW}>
              Rotate Counter-Clockwise
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={toggleGrid}>
              {gridEnabled ? '✓ ' : '   '}Show Grid
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={toggleSnap}>
              {snapEnabled ? '✓ ' : '   '}Snap to Objects
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handlePrevPage} disabled={currentPage <= 1}>
              Previous Page <MenubarShortcut>PgUp</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleNextPage} disabled={currentPage >= totalPages}>
              Next Page <MenubarShortcut>PgDn</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* Markup Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            Markup
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('text')}>
              Text Box <MenubarShortcut>T</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('callout')}>
              Callout
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('cloud')}>
              Cloud <MenubarShortcut>C</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('highlight')}>
              Highlight
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('rectangle')}>
              Rectangle <MenubarShortcut>R</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('ellipse')}>
              Ellipse <MenubarShortcut>E</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('line')}>
              Line <MenubarShortcut>L</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('arrow')}>
              Arrow <MenubarShortcut>A</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('polyline')}>
              Polyline
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('freehand')}>
              Freehand <MenubarShortcut>P</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('stamp')}>
              Stamp
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* Measure Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            Measure
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs" onClick={handleCalibrateScale}>
              Calibrate Scale...
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('measure-length')}>
              Length <MenubarShortcut>M</MenubarShortcut>
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('measure-area')}>
              Area
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('measure-volume')}>
              Volume
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={() => handleToolSelect('measure-count')}>
              Count
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* Document Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            Document
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs" onClick={handleInsertPages} disabled={!currentDoc}>
              Insert Pages...
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleExtractPages} disabled={!currentDoc}>
              Extract Pages...
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleDeletePages} disabled={!currentDoc}>
              Delete Pages...
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleRotatePages} disabled={!currentDoc}>
              Rotate Pages...
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handlePageLabels} disabled={!currentDoc}>
              Page Labels...
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem 
              className="text-xs" 
              onClick={handleOpenOcrDialog} 
              disabled={!currentDoc}
            >
              {ocrStatus.status === 'running' 
                ? `Recognizing Text (${ocrStatus.progress}%)...` 
                : ocrStatus.status === 'completed'
                  ? '✓ Recognize Text (OCR)'
                  : 'Recognize Text (OCR)...'}
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* Window Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            Window
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs">Markups Panel</MenubarItem>
            <MenubarItem className="text-xs">Properties Panel</MenubarItem>
            <MenubarItem className="text-xs">Measurements Panel</MenubarItem>
            <MenubarItem className="text-xs">Thumbnails Panel</MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleResetLayout}>
              Reset Layout
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        {/* Help Menu */}
        <MenubarMenu>
          <MenubarTrigger className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded-sm cursor-pointer">
            Help
          </MenubarTrigger>
          <MenubarContent className="bg-popover border-panel-border min-w-[180px]">
            <MenubarItem className="text-xs" onClick={handleDocumentation}>
              Documentation
            </MenubarItem>
            <MenubarItem className="text-xs" onClick={handleKeyboardShortcuts}>
              Keyboard Shortcuts
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem className="text-xs" onClick={handleAbout}>
              About EZTO Ai
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

      </Menubar>
      
      {/* Spacer to push UserMenu to the right */}
      <div className="flex-1" />
      
      {/* User Menu */}
      <div style={noDragStyle}>
        <UserMenu />
      </div>
      
      {/* Window Controls */}
      <div className="flex items-center ml-2" style={noDragStyle}>
        <button
          onClick={handleWindowMinimize}
          className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="Minimize"
        >
          <Minus className="w-4 h-4" />
        </button>
        <button
          onClick={handleWindowMaximize}
          className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
          title="Maximize"
        >
          <Square className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleWindowClose}
          className="w-8 h-8 flex items-center justify-center text-muted-foreground hover:text-white hover:bg-red-600 transition-colors"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <OcrDialog
        open={ocrDialogOpen}
        onOpenChange={setOcrDialogOpen}
        totalPages={totalPages}
        currentPage={currentPage}
        onRunOcr={handleRunOcr}
        ocrProgress={ocrStatus.progress}
        ocrStatus={ocrStatus.status}
      />
      
      <InsertPagesDialog open={insertPagesOpen} onOpenChange={setInsertPagesOpen} />
      <ExtractPagesDialog open={extractPagesOpen} onOpenChange={setExtractPagesOpen} />
      <DeletePagesDialog open={deletePagesOpen} onOpenChange={setDeletePagesOpen} />
      <RotatePagesDialog open={rotatePagesOpen} onOpenChange={setRotatePagesOpen} />
    </div>
  );
}
