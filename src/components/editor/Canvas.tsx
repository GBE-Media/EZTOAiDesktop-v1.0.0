import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
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
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  
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
    aiSelectionActive,
    aiSelectionRect: storedAiSelectionRect,
    setAiSelectionActive,
    setAiSelectionRect,
    clearAiSelection,
    setAiViewportRect,
    aiCalibrationActive,
    aiCalibrationType,
    aiCalibrationSamples,
    aiSymbolMap,
    aiSymbolDetectionRequested,
    addAiCalibrationSample,
    clearAiSymbolDetectionRequest,
    setAiSymbolMap,
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

  // Handle file drop - accept both PDFs and .ezto files
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isProject = file.name.toLowerCase().endsWith('.ezto');
      
      if (isPdf || isProject) {
        openFile(file);
      }
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

  const screenToCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const transformEl = pdfTransformRef.current;
    if (!transformEl) return null;

    const elementRect = transformEl.getBoundingClientRect();
    const centerX = elementRect.left + elementRect.width / 2;
    const centerY = elementRect.top + elementRect.height / 2;

    const angleRad = (rotation * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const currentScale = zoom / 100;
    const dx = clientX - centerX;
    const dy = clientY - centerY;

    const localX = (dx * cos + dy * sin) / currentScale;
    const localY = (-dx * sin + dy * cos) / currentScale;

    return {
      x: localX + canvasDimensions.width / 2,
      y: localY + canvasDimensions.height / 2,
    };
  }, [canvasDimensions.height, canvasDimensions.width, rotation, zoom]);

  const updateSelectionRect = useCallback((start: { x: number; y: number }, end: { x: number; y: number }) => {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    setSelectionRect({ x, y, width, height });
  }, []);

  const handleSelectionPointerDown = useCallback((e: React.PointerEvent) => {
    if (!aiSelectionActive) return false;
    const point = screenToCanvasPoint(e.clientX, e.clientY);
    if (!point) return false;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsSelecting(true);
    setSelectionStart(point);
    setSelectionRect({ x: point.x, y: point.y, width: 0, height: 0 });
    return true;
  }, [aiSelectionActive, screenToCanvasPoint]);

  const handleCalibrationPointerDown = useCallback((e: React.PointerEvent) => {
    if (!aiCalibrationActive || !aiCalibrationType || !activeDocId) return false;
    const point = screenToCanvasPoint(e.clientX, e.clientY);
    if (!point) return false;
    e.preventDefault();
    const pdfPoint = {
      x: point.x / BASE_RENDER_SCALE,
      y: point.y / BASE_RENDER_SCALE,
    };
    addAiCalibrationSample(activeDocId, currentPage, aiCalibrationType, pdfPoint);
    return true;
  }, [aiCalibrationActive, aiCalibrationType, activeDocId, currentPage, screenToCanvasPoint, addAiCalibrationSample]);

  const handleSelectionPointerMove = useCallback((e: React.PointerEvent) => {
    if (!aiSelectionActive || !isSelecting || !selectionStart) return false;
    const point = screenToCanvasPoint(e.clientX, e.clientY);
    if (!point) return false;
    e.preventDefault();
    updateSelectionRect(selectionStart, point);
    return true;
  }, [aiSelectionActive, isSelecting, selectionStart, screenToCanvasPoint, updateSelectionRect]);

  const handleSelectionPointerUp = useCallback((e: React.PointerEvent) => {
    if (!aiSelectionActive || !isSelecting || !selectionStart) return false;
    const point = screenToCanvasPoint(e.clientX, e.clientY);
    if (!point) return false;
    e.preventDefault();
    e.currentTarget.releasePointerCapture(e.pointerId);
    updateSelectionRect(selectionStart, point);

    const rect = {
      x: Math.min(selectionStart.x, point.x),
      y: Math.min(selectionStart.y, point.y),
      width: Math.abs(point.x - selectionStart.x),
      height: Math.abs(point.y - selectionStart.y),
    };

    if (rect.width < 5 || rect.height < 5 || !activeDocId) {
      clearAiSelection();
    } else {
      const pdfRect = {
        x: rect.x / BASE_RENDER_SCALE,
        y: rect.y / BASE_RENDER_SCALE,
        width: rect.width / BASE_RENDER_SCALE,
        height: rect.height / BASE_RENDER_SCALE,
      };
      setAiSelectionRect(activeDocId, currentPage, pdfRect);
    }

    setIsSelecting(false);
    setSelectionStart(null);
    setAiSelectionActive(false);
    return true;
  }, [aiSelectionActive, isSelecting, selectionStart, screenToCanvasPoint, updateSelectionRect, activeDocId, currentPage, clearAiSelection, setAiSelectionRect, setAiSelectionActive]);

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

  const displaySelectionRect = useMemo(() => {
    if (selectionRect) return selectionRect;
    if (!storedAiSelectionRect || storedAiSelectionRect.docId !== activeDocId || storedAiSelectionRect.page !== currentPage) {
      return null;
    }
    return {
      x: storedAiSelectionRect.rect.x * BASE_RENDER_SCALE,
      y: storedAiSelectionRect.rect.y * BASE_RENDER_SCALE,
      width: storedAiSelectionRect.rect.width * BASE_RENDER_SCALE,
      height: storedAiSelectionRect.rect.height * BASE_RENDER_SCALE,
    };
  }, [activeDocId, currentPage, selectionRect, storedAiSelectionRect]);

  const displayCalibrationSamples = useMemo(() => {
    if (!activeDocId) return {};
    return aiCalibrationSamples[activeDocId]?.[currentPage] || {};
  }, [activeDocId, aiCalibrationSamples, currentPage]);

  const displaySymbolMap = useMemo(() => {
    if (!activeDocId) return {};
    return aiSymbolMap[activeDocId]?.[currentPage] || {};
  }, [activeDocId, aiSymbolMap, currentPage]);

  const detectSymbolsForType = useCallback((type: string, samples: { x: number; y: number }[]) => {
    const sourceCanvas = pdfCanvasRef.current;
    if (!sourceCanvas || samples.length === 0) return [];

    const downscale = 0.5;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.max(1, Math.floor(sourceCanvas.width * downscale));
    tempCanvas.height = Math.max(1, Math.floor(sourceCanvas.height * downscale));
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return [];

    tempCtx.drawImage(sourceCanvas, 0, 0, tempCanvas.width, tempCanvas.height);
    const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;

    const cssToPixelScale = sourceCanvas.width / canvasDimensions.width;
    const pdfToTempScale = BASE_RENDER_SCALE * cssToPixelScale * downscale;

    const patchRadius = 6;
    const patchSize = patchRadius * 2 + 1;
    const template = new Float32Array(patchSize * patchSize);

    let templateCount = 0;
    for (const sample of samples) {
      const centerX = Math.round(sample.x * pdfToTempScale);
      const centerY = Math.round(sample.y * pdfToTempScale);
      if (
        centerX - patchRadius < 0 ||
        centerY - patchRadius < 0 ||
        centerX + patchRadius >= tempCanvas.width ||
        centerY + patchRadius >= tempCanvas.height
      ) {
        continue;
      }
      let idx = 0;
      for (let y = -patchRadius; y <= patchRadius; y += 1) {
        for (let x = -patchRadius; x <= patchRadius; x += 1) {
          const px = (centerX + x + (centerY + y) * tempCanvas.width) * 4;
          const r = data[px];
          const g = data[px + 1];
          const b = data[px + 2];
          template[idx] += 0.299 * r + 0.587 * g + 0.114 * b;
          idx += 1;
        }
      }
      templateCount += 1;
    }

    if (templateCount === 0) return [];
    for (let i = 0; i < template.length; i += 1) {
      template[i] /= templateCount;
    }

    const matches: { x: number; y: number }[] = [];
    const stride = 6;
    const maxMatches = 200;
    const matchThreshold = 20;
    const minDistance = patchRadius * 1.5;

    for (let y = patchRadius; y < tempCanvas.height - patchRadius; y += stride) {
      for (let x = patchRadius; x < tempCanvas.width - patchRadius; x += stride) {
        let diff = 0;
        let idx = 0;
        for (let j = -patchRadius; j <= patchRadius; j += 1) {
          for (let i = -patchRadius; i <= patchRadius; i += 1) {
            const px = (x + i + (y + j) * tempCanvas.width) * 4;
            const r = data[px];
            const g = data[px + 1];
            const b = data[px + 2];
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            diff += Math.abs(gray - template[idx]);
            idx += 1;
          }
        }
        const avgDiff = diff / (patchSize * patchSize);
        if (avgDiff > matchThreshold) continue;

        const pdfX = x / pdfToTempScale;
        const pdfY = y / pdfToTempScale;
        const tooClose = matches.some((m) => {
          const dx = m.x - pdfX;
          const dy = m.y - pdfY;
          return Math.hypot(dx, dy) < minDistance;
        });
        if (tooClose) continue;

        matches.push({ x: pdfX, y: pdfY });
        if (matches.length >= maxMatches) {
          return matches;
        }
      }
    }

    return matches;
  }, [canvasDimensions.width, canvasDimensions.height]);

  const handleCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (handleCalibrationPointerDown(e)) return;
    if (handleSelectionPointerDown(e)) return;
    handlePanPointerDown(e);
  }, [handleCalibrationPointerDown, handleSelectionPointerDown, handlePanPointerDown]);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    if (handleSelectionPointerMove(e)) return;
    handlePanPointerMove(e);
  }, [handleSelectionPointerMove, handlePanPointerMove]);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent) => {
    if (handleSelectionPointerUp(e)) return;
    handlePanPointerUp(e);
  }, [handleSelectionPointerUp, handlePanPointerUp]);

  useEffect(() => {
    if (!activeDocId || !pdfTransformRef.current || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const corners = [
      { x: containerRect.left, y: containerRect.top },
      { x: containerRect.right, y: containerRect.top },
      { x: containerRect.right, y: containerRect.bottom },
      { x: containerRect.left, y: containerRect.bottom },
    ]
      .map(({ x, y }) => screenToCanvasPoint(x, y))
      .filter((point): point is { x: number; y: number } => !!point);

    if (!corners.length) return;

    const minX = Math.max(0, Math.min(...corners.map(p => p.x)));
    const maxX = Math.min(canvasDimensions.width, Math.max(...corners.map(p => p.x)));
    const minY = Math.max(0, Math.min(...corners.map(p => p.y)));
    const maxY = Math.min(canvasDimensions.height, Math.max(...corners.map(p => p.y)));

    const pdfRect = {
      x: minX / BASE_RENDER_SCALE,
      y: minY / BASE_RENDER_SCALE,
      width: Math.max(0, (maxX - minX) / BASE_RENDER_SCALE),
      height: Math.max(0, (maxY - minY) / BASE_RENDER_SCALE),
    };

    setAiViewportRect(activeDocId, currentPage, pdfRect);
  }, [activeDocId, canvasDimensions.height, canvasDimensions.width, currentPage, screenToCanvasPoint, setAiViewportRect, zoom, panOffset, rotation]);

  useEffect(() => {
    if (!aiSymbolDetectionRequested) return;
    if (!activeDocId) {
      clearAiSymbolDetectionRequest();
      return;
    }

    const pageSamples = aiCalibrationSamples[activeDocId]?.[currentPage] || {};
    const types = Object.keys(pageSamples);
    for (const type of types) {
      const samples = pageSamples[type] || [];
      if (samples.length < 3) {
        continue;
      }
      const detected = detectSymbolsForType(type, samples);
      setAiSymbolMap(activeDocId, currentPage, type, detected);
    }
    clearAiSymbolDetectionRequest();
  }, [
    aiSymbolDetectionRequested,
    activeDocId,
    currentPage,
    aiCalibrationSamples,
    detectSymbolsForType,
    setAiSymbolMap,
    clearAiSymbolDetectionRequest,
  ]);

  // No document open - show upload prompt
  // IMPORTANT: Still use containerRef to track dimensions for when a document is loaded
  if (documents.length === 0 || (!doc && !pdfDocument)) {
    return (
      <div 
        ref={containerRef}
        className={`
          flex-1 flex items-center justify-center
          border-2 border-dashed m-4 rounded-lg
          transition-all duration-200
          ${isDragOver 
            ? 'border-primary bg-primary/10' 
            : 'border-muted-foreground/20 bg-secondary/20 hover:border-muted-foreground/40'
          }
        `}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="text-center text-muted-foreground p-8">
          <div className={`
            w-24 h-24 mx-auto mb-6 rounded-full 
            flex items-center justify-center
            transition-all duration-200
            ${isDragOver ? 'bg-primary/20' : 'bg-secondary'}
          `}>
            {isDragOver ? (
              <Upload className="w-12 h-12 text-primary animate-pulse" />
            ) : (
              <FileText className="w-12 h-12 opacity-60" />
            )}
          </div>
          <p className="text-lg font-medium mb-2">
            {isDragOver ? 'Drop PDF here' : 'No document open'}
          </p>
          <p className="text-sm text-muted-foreground mb-6">
            Drag and drop a PDF file here, or click the button below
          </p>
          <label className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-lg cursor-pointer hover:bg-primary/90 transition-colors shadow-sm">
            <Upload className="w-5 h-5" />
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
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
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
                {Object.entries(displaySymbolMap).map(([type, points]) => (
                  <div key={`symbol-${type}`}>
                    {points.map((point, index) => (
                      <div
                        key={`symbol-${type}-${index}`}
                        className="absolute w-2 h-2 rounded-full bg-emerald-500/50 border border-emerald-500 pointer-events-none"
                        style={{
                          left: point.x * BASE_RENDER_SCALE - 4,
                          top: point.y * BASE_RENDER_SCALE - 4,
                        }}
                        title={`${type} (detected)`}
                      />
                    ))}
                  </div>
                ))}
                {Object.entries(displayCalibrationSamples).map(([type, points]) => (
                  <div key={`calibration-${type}`}>
                    {points.map((point, index) => (
                      <div
                        key={`calibration-${type}-${index}`}
                        className="absolute w-3 h-3 rounded-full bg-blue-500/60 border border-blue-500 pointer-events-none"
                        style={{
                          left: point.x * BASE_RENDER_SCALE - 6,
                          top: point.y * BASE_RENDER_SCALE - 6,
                        }}
                        title={`${type} (sample)`}
                      />
                    ))}
                  </div>
                ))}
                {displaySelectionRect && (
                  <div
                    className="absolute border-2 border-violet-500 bg-violet-500/10 pointer-events-none"
                    style={{
                      left: displaySelectionRect.x,
                      top: displaySelectionRect.y,
                      width: displaySelectionRect.width,
                      height: displaySelectionRect.height,
                    }}
                  />
                )}
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
