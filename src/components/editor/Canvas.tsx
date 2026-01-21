import { useRef, useState, useEffect, useCallback } from 'react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useFileOpen } from '@/hooks/useFileOpen';
import { loadPDF, renderPage } from '@/lib/pdfLoader';
import { MarkupCanvas } from './MarkupCanvas';
import { CalibrationDialog } from './CalibrationDialog';
import { FileText, Upload, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

// Base scale for PDF rendering - this is the scale at which we render the PDF
// The pdfLoader already handles high-DPI internally, so we use 1.5 for good quality
// Zoom is applied via CSS transform on top of this
const BASE_RENDER_SCALE = 1.5;

export function Canvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const pdfTransformRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 612, height: 792 });
  const [isDragOver, setIsDragOver] = useState(false);
  
  // Pan state for transform-based panning
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [panOffsetStart, setPanOffsetStart] = useState({ x: 0, y: 0 });
  
  const { documents, activeDocument, gridEnabled, activeTool, rotation } = useEditorStore();
  const { 
    pdfDocuments,
    activeDocId,
    zoom,
    calibration,
    setPdfDocument,
    setActiveDocId,
    setCurrentPage,
    setPageDimensions,
    setContainerDimensions,
    fitToCanvas,
    setPanOffset,
  } = useCanvasStore();
  
  const { openFile } = useFileOpen();
  
  const doc = documents.find((d) => d.id === activeDocument);
  
  // Get current document's PDF data - derive panOffset directly from document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const pdfDocument = currentDocData?.pdfDocument || null;
  const currentPage = currentDocData?.currentPage || 1;
  const totalPages = currentDocData?.totalPages || 0;
  const panOffset = currentDocData?.panOffset || { x: 0, y: 0 };

  // Track container dimensions for fit-to-canvas
  useEffect(() => {
    const updateContainerDimensions = () => {
      if (containerRef.current) {
        const { clientWidth, clientHeight } = containerRef.current;
        setContainerDimensions(clientWidth, clientHeight);
      }
    };

    updateContainerDimensions();
    
    const resizeObserver = new ResizeObserver(updateContainerDimensions);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    return () => resizeObserver.disconnect();
  }, [setContainerDimensions]);

  // Sync canvas store's activeDocId with editorStore's activeDocument
  useEffect(() => {
    if (activeDocument && activeDocument !== activeDocId) {
      // Check if we have PDF data for this document
      if (pdfDocuments[activeDocument]) {
        setActiveDocId(activeDocument);
      }
    }
  }, [activeDocument, activeDocId, pdfDocuments, setActiveDocId]);

  // Auto-fit when PDF first loads
  useEffect(() => {
    if (pdfDocument && containerRef.current && currentDocData && !currentDocData.hasViewState) {
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth > 0 && clientHeight > 0) {
        containerRef.current.scrollTo({ left: 0, top: 0 });
        fitToCanvas(clientWidth, clientHeight);
      }
    }
  }, [pdfDocument, currentDocData, fitToCanvas]);

  // Render PDF page when document or page changes (NOT on zoom - zoom uses CSS transform)
  useEffect(() => {
    const render = async () => {
      if (!pdfDocument || !pdfCanvasRef.current) return;
      
      setLoading(true);
      try {
        // Render at fixed base scale - zoom is handled via CSS transform
        const pageInfo = await renderPage(pdfDocument, currentPage, pdfCanvasRef.current, BASE_RENDER_SCALE);
        setCanvasDimensions({ width: pageInfo.width, height: pageInfo.height });
        setPageDimensions(pageInfo.width, pageInfo.height);
      } catch (err) {
        console.error('Page render error:', err);
      } finally {
        setLoading(false);
      }
    };
    
    render();
  }, [pdfDocument, currentPage, setPageDimensions]); // Note: zoom removed - uses CSS transform

  // Handle file drop
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      openFile(file);
    }
  }, [openFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  // File input for click to upload
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      openFile(file);
    }
  }, [openFile]);

  const goToPage = useCallback((page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  }, [totalPages, setCurrentPage]);

  // Pan handlers - transform-based panning with pointer capture
  const handlePanPointerDown = useCallback((e: React.PointerEvent) => {
    // Middle mouse button (button 1) or pan tool with left click
    const isMiddleClick = e.button === 1;
    const isPanToolClick = activeTool === 'pan' && e.button === 0;
    
    if (!isMiddleClick && !isPanToolClick) return;
    
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsPanning(true);
    setPanStart({ x: e.clientX, y: e.clientY });
    // Read current panOffset from document data directly
    const currentOffset = currentDocData?.panOffset || { x: 0, y: 0 };
    setPanOffsetStart({ x: currentOffset.x, y: currentOffset.y });
  }, [activeTool, currentDocData]);

  const handlePanPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning) return;
    
    e.preventDefault();
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    
    setPanOffset(panOffsetStart.x + dx, panOffsetStart.y + dy);
  }, [isPanning, panStart, panOffsetStart, setPanOffset]);

  const handlePanPointerUp = useCallback((e: React.PointerEvent) => {
    if (isPanning) {
      e.preventDefault();
      e.currentTarget.releasePointerCapture(e.pointerId);
      setIsPanning(false);
    }
  }, [isPanning]);

  // Prevent context menu on middle click
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
    }
  }, []);

  // Handle wheel for scroll zoom at cursor position - Bluebeam/Google Maps style
  // The point under the mouse cursor stays fixed while zooming
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();

    const transformEl = pdfTransformRef.current;
    if (!transformEl) return;

    // Get current state directly for responsiveness
    const state = useCanvasStore.getState();
    const currentZoom = state.zoom;
    const currentPanOffset = state.getPanOffset();

    // Mouse position in screen coordinates
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    // Use the actual on-screen bounds of the transformed PDF element.
    // This avoids assumptions about container centering and scroll offsets.
    const elementRect = transformEl.getBoundingClientRect();
    const currentCenterX = elementRect.left + elementRect.width / 2;
    const currentCenterY = elementRect.top + elementRect.height / 2;

    // Convert rotation to radians (positive is clockwise in CSS)
    const angleRad = (rotation * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    // Google Maps / Bluebeam style zoom steps
    const zoomMultiplier = 1.15;
    const direction = e.deltaY > 0 ? -1 : 1;
    const zoomFactor = direction > 0 ? zoomMultiplier : 1 / zoomMultiplier;
    const newZoom = Math.max(10, Math.min(500, currentZoom * zoomFactor));
    if (Math.abs(newZoom - currentZoom) < 0.01) return;

    const currentScale = currentZoom / 100;
    const newScale = newZoom / 100;

    // Compute document point under cursor in document-local coords (origin at doc center)
    const dx = mouseX - currentCenterX;
    const dy = mouseY - currentCenterY;

    // Undo rotation to get into doc-local axes
    const localX = (dx * cos + dy * sin) / currentScale;
    const localY = (-dx * sin + dy * cos) / currentScale;

    // Compute where the center must move so that the same doc point stays under cursor
    const rotatedX = localX * cos - localY * sin;
    const rotatedY = localX * sin + localY * cos;
    const newCenterX = mouseX - rotatedX * newScale;
    const newCenterY = mouseY - rotatedY * newScale;

    // Translation moves the center in screen coordinates
    // Base center is currentCenter minus current pan
    const baseCenterX = currentCenterX - currentPanOffset.x;
    const baseCenterY = currentCenterY - currentPanOffset.y;
    const newPanX = newCenterX - baseCenterX;
    const newPanY = newCenterY - baseCenterY;

    state.setZoom(newZoom);
    state.setPanOffset(newPanX, newPanY);
  }, [rotation]);

  // No document open - show upload prompt
  // IMPORTANT: Still use containerRef to track dimensions for when a document is loaded
  if (documents.length === 0 || (!doc && !pdfDocument)) {
    return (
      <div 
        ref={containerRef}
        className={`flex-1 flex items-center justify-center bg-canvas transition-colors ${
          isDragOver ? 'bg-primary/10 border-2 border-dashed border-primary' : ''
        }`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="text-center text-muted-foreground">
          <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-secondary/50 flex items-center justify-center">
            {isDragOver ? (
              <Upload className="w-10 h-10 text-primary animate-pulse" />
            ) : (
              <FileText className="w-10 h-10 opacity-50" />
            )}
          </div>
          <p className="text-sm font-medium mb-1">
            {isDragOver ? 'Drop PDF here' : 'No document open'}
          </p>
          <p className="text-xs mb-4">Drag and drop a PDF or click to browse</p>
          <label className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-xs font-medium rounded cursor-pointer hover:bg-primary/90 transition-colors">
            <Upload className="w-4 h-4" />
            Open PDF
            <input 
              type="file" 
              accept="application/pdf" 
              className="hidden" 
              onChange={handleFileSelect}
            />
          </label>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-canvas overflow-hidden">
      {/* Page navigation */}
      {pdfDocument && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-2 border-b border-panel-border bg-panel-header">
          <button
            className="toolbar-button !w-6 !h-6"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={1}
              max={totalPages}
              value={currentPage}
              onChange={(e) => goToPage(parseInt(e.target.value) || 1)}
              className="w-12 h-6 text-center text-xs bg-secondary border border-panel-border rounded"
            />
            <span className="text-xs text-muted-foreground">of {totalPages}</span>
          </div>
          <button
            className="toolbar-button !w-6 !h-6"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main canvas area */}
      <div 
        ref={containerRef}
        className={`flex-1 overflow-auto relative ${isPanning ? 'cursor-grabbing' : activeTool === 'pan' ? 'cursor-grab' : ''}`}
        style={{ touchAction: activeTool === 'pan' ? 'none' : 'auto' }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onPointerDown={handlePanPointerDown}
        onPointerMove={handlePanPointerMove}
        onPointerUp={handlePanPointerUp}
        onPointerCancel={handlePanPointerUp}
        onContextMenu={handleContextMenu}
        onWheel={handleWheel}
      >
        
        {/* PDF Page - CSS transform for zoom, pan, and rotation */}
        <div 
          className="flex items-center justify-center"
          style={{ 
            minWidth: '100%',
            minHeight: '100%',
            width: 'max-content',
            height: 'max-content',
            padding: '64px',
          }}
        >
          {/* Zoom/Pan/Rotate container - CSS transform for instant zoom */}
          <div 
            className="relative shadow-2xl"
            ref={pdfTransformRef}
            style={{
              // Transform order: translate first (for panning), then scale (for zoom), then rotate
              // The PDF renderer already handles internal scaling and outputs CSS-sized elements
              // So we just apply zoom/100 directly: zoom=100 means scale(1), zoom=200 means scale(2)
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom / 100}) rotate(${rotation}deg)`,
              transformOrigin: 'center center',
              willChange: 'transform', // Hint for GPU acceleration
            }}
          >
            {/* Loading indicator */}
            {loading && (
              <div className="absolute inset-0 bg-background/80 flex items-center justify-center z-10">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
              </div>
            )}
            
            {/* PDF canvas */}
            {pdfDocument ? (
              <>
                <canvas 
                  ref={pdfCanvasRef} 
                  className="bg-white"
                />
                {/* Markup overlay canvas */}
                <MarkupCanvas 
                  width={canvasDimensions.width} 
                  height={canvasDimensions.height} 
                />
              </>
            ) : (
              /* Placeholder document */
              <div className="bg-white" style={{ width: '612px', height: '792px' }}>
                <div className="absolute inset-0 p-8">
                  <div className="border-2 border-gray-300 h-full relative">
                    <div className="absolute inset-4 border border-dashed border-gray-200" />
                    <div className="absolute top-8 left-8 text-xs text-gray-500 font-mono">ROOM 101</div>
                    <div className="absolute top-8 right-8 text-xs text-gray-500 font-mono">ROOM 102</div>
                    <div className="absolute bottom-8 left-8 text-xs text-gray-500 font-mono">ROOM 103</div>
                    <div className="absolute bottom-8 right-8 text-xs text-gray-500 font-mono">ROOM 104</div>
                    <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-200" />
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-200" />
                    
                    <div className="absolute top-16 left-16 w-32 h-20 border-2 border-red-500 rounded-lg bg-red-500/10 flex items-center justify-center">
                      <span className="text-[10px] text-red-600 font-medium">RFI #127</span>
                    </div>
                    
                    <div className="absolute top-40 right-20">
                      <div className="bg-blue-500 text-white text-[10px] px-2 py-1 rounded">Verify with structural</div>
                    </div>
                    
                    <div className="absolute bottom-0 right-0 w-48 h-24 border-t-2 border-l-2 border-gray-400 bg-gray-50/50 p-2">
                      <div className="text-[8px] text-gray-600 font-mono">
                        <div className="font-bold">FLOOR PLAN - LEVEL 1</div>
                        <div className="mt-1">SCALE: 1/4" = 1'-0"</div>
                        <div>DATE: 2024-01-09</div>
                        <div>SHEET: A-101</div>
                      </div>
                    </div>
                  </div>
                </div>
                {/* Markup overlay for placeholder */}
                <MarkupCanvas width={612} height={792} />
              </div>
            )}
          </div>
        </div>

        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary flex items-center justify-center z-20">
            <div className="bg-panel p-6 rounded-lg shadow-lg text-center">
              <Upload className="w-12 h-12 mx-auto mb-2 text-primary" />
              <p className="text-sm font-medium">Drop PDF to open</p>
            </div>
          </div>
        )}
      </div>

      {/* Calibration dialog */}
      {calibration.isCalibrating && calibration.point1 && calibration.point2 && (
        <CalibrationDialog />
      )}
    </div>
  );
}
