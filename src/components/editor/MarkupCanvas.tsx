import { useRef, useEffect, useState, useCallback, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '@/store/canvasStore';
import { beginEditorInteraction, endEditorInteraction } from '@/store/editorInteractionBusy';
import { useEditorStore } from '@/store/editorStore';
import type { ToolType } from '@/types/editor';
import { useProductStore } from '@/store/productStore';
import { productHighlight } from '@/lib/productHighlight';
import { takeoffColor } from '@/lib/takeoffColors';

/** Count markers for a product share its color (same key the AI uses for fixture types). */
function productMarkerColor(productId: string): { strokeColor: string; fillColor: string } {
  const node = useProductStore.getState().nodes[productId];
  const key = node?.notes?.match(/bidvera-key:(\S+)/)?.[1] || `product:${productId}`;
  const color = takeoffColor(key);
  return { strokeColor: color, fillColor: color };
}
import { useHistoryStore } from '@/store/historyStore';
import { 
  getTextContentWithBounds, 
  TextItemWithBounds, 
  TextWord,
  findWordAtPoint,
  findWordsInRange,
  groupWordsByLine,
  getWordsBoundingBox,
  getWordsFromTextItems,
} from '@/lib/pdfLoader';
import type { 
  CanvasMarkup,
  AiRunMeta,
  Point, 
  RectangleMarkup, 
  LineMarkup, 
  PolygonMarkup, 
  TextMarkup,
  StampMarkup,
  CountMarkerMarkup,
  StampPreset,
} from '@/types/markup';
import { TextEditOverlay } from './TextEditOverlay';
import { isRunMarkup, recomputeRunMarkup } from '@/services/ai/runs/overlay';
import { runProductFeet } from '@/services/ai/runs/runMaterials';
import { followAnchoredRuns } from '@/services/ai/runs/anchors';
import { countMarkerCaption, resolveMarkupDrawAppearance } from './markupDrawAppearance';
import { getCachedPageZones } from '@/services/ai/detection/pageZones';
import { pageGeometryFromUnrotated, visionDisplayPctRectToDoc } from '@/services/ai/placement/visionDisplayPctToDoc';
import {
  computeAreaMeasurementFromPoints,
  computeLengthMeasurement,
} from '@/lib/measurementValues';
import { pageCalibrationToRenderPixelsPerUnit } from '@/services/ai/placement/pageCalibration';
import { useDrawingPickStore } from '@/store/drawingPickStore';
import { docToRender, getRenderPageSize } from '@/services/ai/placement/coords';
import { visionDisplayPctToDoc } from '@/services/ai/placement/visionDisplayPctToDoc';

const EMPTY_MARKUPS: CanvasMarkup[] = [];

interface MarkupCanvasProps {
  width: number;
  height: number;
}

// Stamp preset configurations
const STAMP_PRESETS: Record<StampPreset, { label: string; color: string; bgColor: string }> = {
  approved: { label: 'APPROVED', color: '#22c55e', bgColor: 'rgba(34, 197, 94, 0.15)' },
  rejected: { label: 'REJECTED', color: '#ef4444', bgColor: 'rgba(239, 68, 68, 0.15)' },
  draft: { label: 'DRAFT', color: '#f97316', bgColor: 'rgba(249, 115, 22, 0.15)' },
  reviewed: { label: 'REVIEWED', color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.15)' },
  confidential: { label: 'CONFIDENTIAL', color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.15)' },
  void: { label: 'VOID', color: '#6b7280', bgColor: 'rgba(107, 114, 128, 0.15)' },
};

// Note: Count marker numbers are no longer tracked - total is shown in tab bar

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end' | `v${number}`;

const vertexIndexOf = (handle: ResizeHandle): number | null =>
  handle.startsWith('v') ? Number(handle.slice(1)) : null;

interface ResizeState {
  handle: ResizeHandle;
  startX: number;
  startY: number;
  originalMarkup: CanvasMarkup;
}

// Helper to draw scalloped cloud edges between two points
const drawCloudEdge = (
  ctx: CanvasRenderingContext2D,
  start: Point,
  end: Point,
  outward: boolean = true
) => {
  const dist = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
  if (dist < 1) return;
  
  const targetArcSize = 12; // Target size for each scallop arc
  const numArcs = Math.max(2, Math.round(dist / targetArcSize));
  
  const dx = (end.x - start.x) / numArcs;
  const dy = (end.y - start.y) / numArcs;
  
  // Calculate perpendicular direction for bulge (outward from polygon center)
  const perpScale = outward ? 1 : -1;
  const bulgeAmount = targetArcSize * 0.35;
  const perpX = (-dy / dist) * bulgeAmount * perpScale;
  const perpY = (dx / dist) * bulgeAmount * perpScale;
  
  for (let i = 0; i < numArcs; i++) {
    const x1 = start.x + dx * i;
    const y1 = start.y + dy * i;
    const x2 = start.x + dx * (i + 1);
    const y2 = start.y + dy * (i + 1);
    const midX = (x1 + x2) / 2 + perpX;
    const midY = (y1 + y2) / 2 + perpY;
    
    ctx.quadraticCurveTo(midX, midY, x2, y2);
  }
};

// Helper to find text items in a selection region
const findTextInRegion = (
  textItems: TextItemWithBounds[],
  selectionBox: { x: number; y: number; width: number; height: number }
): TextItemWithBounds[] => {
  return textItems.filter(item => {
    // Check if text item intersects with selection
    return !(
      item.x + item.width < selectionBox.x ||
      item.x > selectionBox.x + selectionBox.width ||
      item.y + item.height < selectionBox.y ||
      item.y > selectionBox.y + selectionBox.height
    );
  });
};

// Helper to get bounding box from text items
const getTextBoundingBox = (items: TextItemWithBounds[]) => {
  if (items.length === 0) return null;
  
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const item of items) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }
  
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export function MarkupCanvas({ width, height }: MarkupCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragOffset, setDragOffset] = useState<Point>({ x: 0, y: 0 });
  const [editingTextMarkup, setEditingTextMarkup] = useState<TextMarkup | null>(null);
  const [eraserHoveredId, setEraserHoveredId] = useState<string | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<ResizeHandle | null>(null);
  const [countMenu, setCountMenu] = useState<{
    x: number;
    y: number;
    markupId: string;
    groupId: string;
    productId?: string;
  } | null>(null);
  
  // Text selection state for professional highlight tool
  const [highlightSelection, setHighlightSelection] = useState<{
    startWord: TextWord | null;
    currentWord: TextWord | null;
    selectedWords: TextWord[];
  } | null>(null);
  const [isOverText, setIsOverText] = useState(false);
  
  const {
    pdfDocuments,
    activeDocId,
    selectedMarkupIds,
    hoveredMarkupId,
    drawing,
    calibration,
    gridSize,
    snapToGrid,
    snapToObjects,
    defaultStyle,
    zoom,
    activeSnapPoint,
    addMarkup,
    updateMarkup,
    deleteMarkups,
    setMarkupsForPage,
    selectMarkup,
    clearSelection,
    setHoveredMarkup,
    startDrawing,
    finishDrawing,
    cancelDrawing,
    getSnapPoint,
    setCalibrationPoint,
    cancelCalibration,
    getScaleForPage,
    getTextContent,
    setTextContent,
    getTextWords,
    setTextWords,
    getPdfDocument,
    getOcrStatus,
    extractDocumentSnapData,
    setActiveSnapPoint,
    aiPreview,
    aiPreviewHoverId,
    showPageZones,
  } = useCanvasStore();

  const { activeTool, selectedStamp, gridEnabled, rotation } = useEditorStore();
  const { activeProductId, linkMeasurement, activeCountGroupId, setActiveCountGroup, setActiveProduct } = useProductStore();
  
  // Get current document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const currentPage = currentDocData?.currentPage || 1;
  const markupsByPage = currentDocData?.markupsByPage;
  const markups = (markupsByPage && markupsByPage[currentPage]) || EMPTY_MARKUPS;
  // Product picked in the Products panel: its counts / runs light up, on every page.
  const selectedProductNodeId = useProductStore(state => state.selectedNodeId);
  const productNodes = useProductStore(state => state.nodes);
  const highlight = productHighlight(productNodes, selectedProductNodeId, activeDocId);
  const highlightKey = highlight ? `${highlight.nodeId}:${highlight.total}` : '';
  const highlightIds = highlight?.ids;
  const pickRequest = useDrawingPickStore(state => state.request);
  const pickPins = useDrawingPickStore(state => state.pins);
  const pickAreas = useDrawingPickStore(state => state.areas);
  /** Box being dragged for an "areas to keep clear" question (doc points). */
  const [areaDrag, setAreaDrag] = useState<{ start: Point; current: Point } | null>(null);
  const isPicking = !!pickRequest && (!pickRequest.documentId || pickRequest.documentId === activeDocId);
  const isPanMode = activeTool === 'pan' && !isPicking;
  // Prefer per-page PageCalibration; fall back to legacy document-wide scale.
  const { scale: measureScale, unit: measureUnit } = getScaleForPage(currentPage);

  // Helper that wraps getSnapPoint to extract point and update active snap indicator
  const getSnappedPoint = useCallback((rawPoint: Point): Point => {
    const result = getSnapPoint(rawPoint);
    setActiveSnapPoint(result.snapPoint);
    return result.point;
  }, [getSnapPoint, setActiveSnapPoint]);

  // Extract document snap data when page changes and snap to objects is enabled
  useEffect(() => {
    if (snapToObjects && currentPage && activeDocId) {
      extractDocumentSnapData(currentPage);
    }
  }, [currentPage, snapToObjects, activeDocId, extractDocumentSnapData]);

  // Draw all markups and overlays
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Draw grid if grid toggle is enabled
    if (gridEnabled) {
      ctx.strokeStyle = 'rgba(100, 100, 100, 0.1)';
      ctx.lineWidth = 1;

      // Grid is in PDF space; CSS transform handles zoom
      const gridStep = gridSize;

      for (let x = 0; x <= width; x += gridStep) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      
      for (let y = 0; y <= height; y += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }
    
    // Draw existing markups
    const highlighting = !!highlightIds && highlightIds.size > 0;
    markups.forEach((markup) => {
      const isSelected = selectedMarkupIds.includes(markup.id);
      const isHovered = hoveredMarkupId === markup.id;
      const isEraserHovered = eraserHoveredId === markup.id;
      const dim = highlighting && !highlightIds!.has(markup.id) && (markup.type === 'count-marker' || !!markup.aiRun);
      if (dim) {
        ctx.save();
        ctx.globalAlpha = 0.22;
      }
      drawMarkup(ctx, markup, isSelected, isHovered, isEraserHovered);
      if (dim) ctx.restore();
    });
    if (highlighting) {
      // Halo every markup of the selected product so it's easy to spot on the print.
      const s = 100 / Math.max(zoom, 10);
      ctx.save();
      ctx.setLineDash([]);
      markups.forEach(markup => {
        if (!highlightIds!.has(markup.id)) return;
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.95)';
        ctx.shadowColor = 'rgba(250, 204, 21, 0.9)';
        ctx.shadowBlur = 10 * s;
        if (markup.type === 'count-marker') {
          ctx.lineWidth = 3 * s;
          ctx.beginPath();
          ctx.arc(markup.x, markup.y, 17, 0, Math.PI * 2);
          ctx.stroke();
        } else if ('points' in markup && Array.isArray(markup.points) && markup.points.length > 1) {
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = Math.max(6 * s, (markup.style.strokeWidth || 1) * 3);
          ctx.beginPath();
          ctx.moveTo(markup.points[0].x, markup.points[0].y);
          markup.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else if ('width' in markup && 'x' in markup) {
          ctx.lineWidth = 3 * s;
          ctx.strokeRect(markup.x, markup.y, markup.width, markup.height);
        }
      });
      ctx.restore();
    }

    if (aiPreview && aiPreview.docId === activeDocId) {
      const previewRows = aiPreview.markups.filter(row => row.page === currentPage);
      previewRows.forEach((row, index) => {
        const hovered = aiPreviewHoverId === row.markup.id;
        const overlay = {
          ...row.markup,
          aiPending: true,
          label: row.markup.label || String(index + 1),
        } as typeof row.markup;
        ctx.save();
        ctx.globalAlpha = hovered ? 1 : 0.65;
        if (hovered) ctx.shadowColor = '#f59e0b';
        if (hovered) ctx.shadowBlur = 16;
        drawMarkup(ctx, overlay, false, hovered, false);
        ctx.restore();
      });
    }

    if (showPageZones && activeDocId) {
      const zones = getCachedPageZones(activeDocId, currentPage) || [];
      const palette: Record<string, string> = {
        plan: '#10b981',
        enlarged_plan: '#14b8a6',
        demo_plan: '#f97316',
        photometric: '#0ea5e9',
        schedule: '#6366f1',
        legend: '#8b5cf6',
        notes: '#f59e0b',
        detail: '#ef4444',
        diagram: '#3b82f6',
        title_block: '#64748b',
        key_plan: '#22c55e',
        revisions: '#a855f7',
      };
      const cachedGeometry = useCanvasStore.getState().getPageGeometry(currentPage);
      const zoneGeometry = pageGeometryFromUnrotated({
        pageNumber: currentPage,
        docWidth: cachedGeometry?.docWidth || width,
        docHeight: cachedGeometry?.docHeight || height,
        rotationDeg: cachedGeometry?.rotationDeg ?? 0,
      });
      zones.forEach(zone => {
        if (zone.source === 'sheet') return;
        // Zone bounds are display-percent; markups live in unrotated doc points.
        const rect = visionDisplayPctRectToDoc(zone.bounds, zoneGeometry);
        ctx.save();
        ctx.strokeStyle = palette[zone.kind] || '#94a3b8';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        ctx.setLineDash([]);
        ctx.fillStyle = palette[zone.kind] || '#94a3b8';
        ctx.font = '11px Arial';
        ctx.fillText(zone.label || zone.kind, rect.x + 4, rect.y + 14);
        ctx.restore();
      });
    }
    
    // Points the user picked for an AI question card.
    const pinsHere = Object.values(pickPins).filter(pin => pin.page === currentPage && (!pin.documentId || pin.documentId === activeDocId));
    if (pinsHere.length) {
      const pinGeometry = pickGeometry(currentPage);
      const s = 100 / Math.max(zoom, 10);
      pinsHere.forEach(pin => {
        const p = visionDisplayPctToDoc({ x: pin.xPct, y: pin.yPct }, pinGeometry);
        ctx.save();
        ctx.fillStyle = 'rgba(139, 92, 246, 0.25)';
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 2 * s;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#8b5cf6';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `${Math.round(12 * s)}px Arial`;
        ctx.fillText(pin.label.replace(/^Click\s+/i, '').replace(/\s+on the drawing$/i, ''), p.x + 18 * s, p.y + 4 * s);
        ctx.restore();
      });
    }

    // Areas the user dragged for an AI question card (and the one being dragged).
    const areaGeometry = pickGeometry(currentPage);
    const areasHere = Object.values(pickAreas).flatMap(list => list.map((a, i) => ({ ...a, n: i + 1 }))).filter(a => a.page === currentPage && (!a.documentId || a.documentId === activeDocId));
    const areaRects = areasHere.map(a => {
      const p1 = visionDisplayPctToDoc({ x: a.xPct, y: a.yPct }, areaGeometry);
      const p2 = visionDisplayPctToDoc({ x: a.xPct + a.wPct, y: a.yPct + a.hPct }, areaGeometry);
      return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y), n: a.n as number | undefined, label: a.label };
    });
    if (areaDrag) {
      areaRects.push({
        x: Math.min(areaDrag.start.x, areaDrag.current.x),
        y: Math.min(areaDrag.start.y, areaDrag.current.y),
        w: Math.abs(areaDrag.current.x - areaDrag.start.x),
        h: Math.abs(areaDrag.current.y - areaDrag.start.y),
        n: undefined,
        label: undefined,
      });
    }
    if (areaRects.length) {
      const s = 100 / Math.max(zoom, 10);
      ctx.save();
      areaRects.forEach(r => {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.22)';
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = 2 * s;
        ctx.setLineDash([6 * s, 4 * s]);
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        if (r.n) {
          // Number matches the chip on the question card (remove a wrong one there).
          ctx.setLineDash([]);
          ctx.font = `600 ${11 * s}px Inter, sans-serif`;
          const text = r.label ? `${r.n} ${r.label}` : String(r.n);
          const tw = ctx.measureText(text).width + 8 * s;
          ctx.fillStyle = '#b45309';
          ctx.fillRect(r.x, r.y - 16 * s, tw, 16 * s);
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, r.x + 4 * s, r.y - 8 * s);
        }
      });
      ctx.restore();
    }

    // Draw preview markup while drawing
    if (drawing.isDrawing && drawing.currentPoints.length > 0) {
      drawPreview(ctx, activeTool, drawing.currentPoints, defaultStyle);
    }
    
    // Draw calibration line (in PDF space, needs scaling)
    if (calibration.isCalibrating) {
      const scale = zoom / 100;

      if (calibration.point1) {
        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.arc(calibration.point1.x, calibration.point1.y, 6 / scale, 0, Math.PI * 2);
        ctx.fill();
        
        if (calibration.point2) {
          ctx.beginPath();
          ctx.arc(calibration.point2.x, calibration.point2.y, 6 / scale, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.strokeStyle = '#22c55e';
          ctx.lineWidth = 2 / scale;
          ctx.setLineDash([5 / scale, 5 / scale]);
          ctx.beginPath();
          ctx.moveTo(calibration.point1.x, calibration.point1.y);
          ctx.lineTo(calibration.point2.x, calibration.point2.y);
          ctx.stroke();
          ctx.setLineDash([]);
          
          // Show pixel distance
          const distance = Math.sqrt(
            Math.pow(calibration.point2.x - calibration.point1.x, 2) +
            Math.pow(calibration.point2.y - calibration.point1.y, 2)
          );
          
          const midX = (calibration.point1.x + calibration.point2.x) / 2;
          const midY = (calibration.point1.y + calibration.point2.y) / 2;
          
          ctx.fillStyle = '#22c55e';
          ctx.font = `${12 / scale}px monospace`;
          ctx.fillText(`${distance.toFixed(1)}px`, midX + 10 / scale, midY - 10 / scale);
        }
      }
    }
    
    // Draw highlight text selection preview (text words are in screen space from OCR)
    if (highlightSelection?.selectedWords && highlightSelection.selectedWords.length > 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(253, 224, 71, 0.4)'; // Yellow highlight
      
      // Group words by line and draw highlight per line
      const lineGroups = groupWordsByLine(highlightSelection.selectedWords);
      for (const lineWords of lineGroups) {
        const bounds = getWordsBoundingBox(lineWords);
        const padding = 2;
        ctx.fillRect(
          bounds.x - padding,
          bounds.y - padding,
          bounds.width + padding * 2,
          bounds.height + padding * 2
        );
      }
      ctx.restore();
    }
    
    // Draw active snap point indicator (visual feedback when snapping)
    if (activeSnapPoint && drawing.isDrawing) {
      const scale = zoom / 100;
      const snapIndicatorSize = 6 / scale;
      const { x, y, type } = activeSnapPoint;
      
      // Color code by snap type
      switch (type) {
        case 'document-endpoint':
          // Green circle for document endpoints
          ctx.strokeStyle = '#22c55e';
          ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
          ctx.lineWidth = 2 / scale;
          ctx.beginPath();
          ctx.arc(x, y, snapIndicatorSize, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          break;
          
        case 'document-line':
          // Blue crosshair for line snap
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 2 / scale;
          ctx.beginPath();
          ctx.moveTo(x - snapIndicatorSize, y);
          ctx.lineTo(x + snapIndicatorSize, y);
          ctx.moveTo(x, y - snapIndicatorSize);
          ctx.lineTo(x, y + snapIndicatorSize);
          ctx.stroke();
          break;
          
        case 'intersection':
          // Orange diamond for intersections
          ctx.strokeStyle = '#f97316';
          ctx.fillStyle = 'rgba(249, 115, 22, 0.3)';
          ctx.lineWidth = 2 / scale;
          ctx.beginPath();
          ctx.moveTo(x, y - snapIndicatorSize);
          ctx.lineTo(x + snapIndicatorSize, y);
          ctx.lineTo(x, y + snapIndicatorSize);
          ctx.lineTo(x - snapIndicatorSize, y);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          break;
          
        case 'corner':
        case 'endpoint':
          // Purple for markup corners/endpoints
          ctx.strokeStyle = '#8b5cf6';
          ctx.fillStyle = 'rgba(139, 92, 246, 0.3)';
          ctx.lineWidth = 2 / scale;
          ctx.fillRect(x - snapIndicatorSize/2, y - snapIndicatorSize/2, snapIndicatorSize, snapIndicatorSize);
          ctx.strokeRect(x - snapIndicatorSize/2, y - snapIndicatorSize/2, snapIndicatorSize, snapIndicatorSize);
          break;
          
        case 'midpoint':
        case 'center':
          // Cyan for midpoints/centers
          ctx.strokeStyle = '#06b6d4';
          ctx.lineWidth = 2 / scale;
          ctx.beginPath();
          ctx.arc(x, y, snapIndicatorSize / 2, 0, Math.PI * 2);
          ctx.stroke();
          break;
          
        case 'grid':
          // Gray for grid snap
          ctx.strokeStyle = '#6b7280';
          ctx.lineWidth = 1 / scale;
          ctx.beginPath();
          ctx.moveTo(x - snapIndicatorSize, y);
          ctx.lineTo(x + snapIndicatorSize, y);
          ctx.moveTo(x, y - snapIndicatorSize);
          ctx.lineTo(x, y + snapIndicatorSize);
          ctx.stroke();
          break;
      }
      
    }
  }, [width, height, markups, selectedMarkupIds, hoveredMarkupId, eraserHoveredId, drawing, calibration, gridSize, snapToGrid, activeTool, defaultStyle, highlightSelection, zoom, activeSnapPoint, gridEnabled, measureScale, measureUnit, aiPreview, aiPreviewHoverId, showPageZones, activeDocId, currentPage, pickPins, pickAreas, areaDrag, highlightKey]);

  useEffect(() => {
    draw();
  }, [draw]);

  const drawMarkup = (
    ctx: CanvasRenderingContext2D, 
    markup: CanvasMarkup, 
    isSelected: boolean, 
    isHovered: boolean,
    isEraserHovered: boolean = false
  ) => {
    ctx.save();
    
    // Markups are stored in PDF space; CSS transform handles zoom
    const scale = zoom / 100;
    
    ctx.globalAlpha = markup.style.opacity / 100;
    
    // Eraser hover effect - show in red
    if (isEraserHovered) {
      ctx.strokeStyle = '#ef4444';
      ctx.fillStyle = 'rgba(239, 68, 68, 0.3)';
      ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
      ctx.shadowBlur = 15 / scale; // Adjust shadow for zoom
    } else {
      ctx.strokeStyle = markup.style.strokeColor;
      ctx.fillStyle = markup.style.fillColor === 'transparent' ? 'transparent' : markup.style.fillColor;
    }
    ctx.lineWidth = markup.style.strokeWidth;
    
    if (isSelected && !isEraserHovered) {
      ctx.shadowColor = 'rgba(59, 130, 246, 0.5)';
      ctx.shadowBlur = 10 / scale;
    }
    
    if (isHovered && !isSelected && !isEraserHovered) {
      ctx.shadowColor = 'rgba(59, 130, 246, 0.3)';
      ctx.shadowBlur = 5 / scale;
    }

    // Needs-confirmation AI markups: emerald dashed outline (ApprovalCard emerald language).
    const pendingAppearance = resolveMarkupDrawAppearance({
      markup,
      isEraserHovered,
      scale,
    });
    if (pendingAppearance.lineDash.length > 0) {
      ctx.setLineDash(pendingAppearance.lineDash);
    }
    if (pendingAppearance.strokeStyle && !isEraserHovered) {
      ctx.strokeStyle = pendingAppearance.strokeStyle;
    }
    if (pendingAppearance.fillAlphaScale < 1) {
      ctx.globalAlpha = Math.min(ctx.globalAlpha, pendingAppearance.fillAlphaScale);
    }
    
    switch (markup.type) {
      case 'rectangle': {
        const m = markup as RectangleMarkup;
        if (m.style.fillColor !== 'transparent' || isEraserHovered) {
          ctx.fillRect(m.x, m.y, m.width, m.height);
        }
        if (m.aiRun?.kind === 'keepout' && !isEraserHovered) {
          // Keep-clear (no-fly) areas: diagonal hatch in paper units so they read as "no runs here".
          const step = Math.max(4, m.style.strokeWidth * 5);
          ctx.save();
          ctx.beginPath();
          ctx.rect(m.x, m.y, m.width, m.height);
          ctx.clip();
          ctx.strokeStyle = 'rgba(249, 115, 22, 0.55)';
          ctx.lineWidth = Math.max(0.5, m.style.strokeWidth * 0.5);
          ctx.setLineDash([]);
          ctx.beginPath();
          for (let d = -m.height; d < m.width; d += step) {
            ctx.moveTo(m.x + d, m.y + m.height);
            ctx.lineTo(m.x + d + m.height, m.y);
          }
          ctx.stroke();
          ctx.restore();
        }
        if (m.aiRun?.kind === 'keepout') ctx.setLineDash([m.style.strokeWidth * 4, m.style.strokeWidth * 2.5]);
        ctx.strokeRect(m.x, m.y, m.width, m.height);
        ctx.setLineDash([]);
        if (m.aiRun && m.label && !isEraserHovered) {
          // Run-plan boxes (keep-clear, panel): label in paper units, tied to the box.
          drawPaperTag(ctx, m.label, { x: m.x, y: m.y }, m.aiRun.kind === 'keepout' ? '#c2410c' : '#111827', Math.max(6, m.style.strokeWidth * 4.5));
        } else if (m.aiGenerated && m.label && !isEraserHovered) {
          const fontSize = Math.max(10, m.style.fontSize || 11);
          ctx.save();
          ctx.font = `600 ${fontSize}px ${m.style.fontFamily || 'Arial'}`;
          const labelWidth = Math.min(
            Math.max(60, ctx.measureText(m.label).width + 12),
            Math.max(60, m.width)
          );
          const labelHeight = fontSize + 8;
          const labelY = Math.max(0, m.y - labelHeight);
          ctx.globalAlpha = 1;
          ctx.fillStyle = m.aiRun ? (m.aiRun.kind === 'keepout' ? '#b45309' : '#111827') : '#10b981';
          ctx.fillRect(m.x, labelY, labelWidth, labelHeight);
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(m.label, m.x + 6, labelY + labelHeight / 2, labelWidth - 12);
          ctx.restore();
        }
        break;
      }
      
      case 'highlight': {
        const m = markup as RectangleMarkup;
        // Highlighter appearance: semi-transparent yellow fill, no visible stroke
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = isEraserHovered ? 'rgba(239, 68, 68, 0.5)' : '#fde047'; // Yellow highlight
        ctx.fillRect(m.x, m.y, m.width, m.height);
        ctx.restore();
        break;
      }
      
      case 'ellipse': {
        const m = markup as RectangleMarkup;
        ctx.beginPath();
        ctx.ellipse(
          m.x + m.width / 2,
          m.y + m.height / 2,
          m.width / 2,
          m.height / 2,
          0, 0, Math.PI * 2
        );
        if (m.style.fillColor !== 'transparent' || isEraserHovered) {
          ctx.fill();
        }
        ctx.stroke();
        if (m.aiRun?.kind === 'riser' && !isEraserHovered) {
          // Riser / floor continuation: arrow inside the circle (up or down) + paper-unit tag.
          const cx = m.x + m.width / 2;
          const cy = m.y + m.height / 2;
          const r = Math.min(m.width, m.height) / 2;
          const dir = m.aiRun.riser?.direction === 'up' ? -1 : 1;
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = m.style.strokeColor;
          ctx.fillStyle = m.style.strokeColor;
          ctx.lineWidth = Math.max(1, m.style.strokeWidth);
          ctx.beginPath();
          ctx.moveTo(cx, cy - dir * r * 0.6);
          ctx.lineTo(cx, cy + dir * r * 0.6);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx, cy + dir * r * 0.75);
          ctx.lineTo(cx - r * 0.35, cy + dir * r * 0.25);
          ctx.lineTo(cx + r * 0.35, cy + dir * r * 0.25);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          if (m.label) drawPaperTag(ctx, m.label, { x: m.x + m.width * 1.15, y: m.y }, '#1e3a8a', Math.max(6, m.style.strokeWidth * 4.5));
        }
        break;
      }
      
      case 'line': {
        const m = markup as LineMarkup;
        ctx.beginPath();
        ctx.moveTo(m.startX, m.startY);
        ctx.lineTo(m.endX, m.endY);
        ctx.stroke();
        break;
      }
      
      case 'arrow': {
        const m = markup as LineMarkup;
        const angle = Math.atan2(m.endY - m.startY, m.endX - m.startX);
        const headLength = 15;
        
        ctx.beginPath();
        ctx.moveTo(m.startX, m.startY);
        ctx.lineTo(m.endX, m.endY);
        ctx.stroke();
        
        // Arrow head
        ctx.beginPath();
        ctx.moveTo(m.endX, m.endY);
        ctx.lineTo(
          m.endX - headLength * Math.cos(angle - Math.PI / 6),
          m.endY - headLength * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          m.endX - headLength * Math.cos(angle + Math.PI / 6),
          m.endY - headLength * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
        break;
      }
      
      case 'cloud':
      case 'polygon':
      case 'polyline':
      case 'freehand': {
        const m = markup as PolygonMarkup;
        if (m.points.length < 2) break;
        
        ctx.beginPath();
        ctx.moveTo(m.points[0].x, m.points[0].y);
        
        if (markup.type === 'cloud') {
          // Draw cloud with multiple scalloped arcs per edge
          for (let i = 1; i < m.points.length; i++) {
            drawCloudEdge(ctx, m.points[i - 1], m.points[i], true);
          }
          // Close with scalloped edge back to first point
          drawCloudEdge(ctx, m.points[m.points.length - 1], m.points[0], true);
        } else if (m.aiRun?.curve && m.points.length === 3) {
          // Revit-style wiring arc from fixture to fixture, through the (draggable) middle point.
          const [a, mid, b] = m.points;
          ctx.quadraticCurveTo(2 * mid.x - (a.x + b.x) / 2, 2 * mid.y - (a.y + b.y) / 2, b.x, b.y);
        } else {
          for (let i = 1; i < m.points.length; i++) {
            ctx.lineTo(m.points[i].x, m.points[i].y);
          }
        }
        
        if (markup.type !== 'polyline' && markup.type !== 'freehand') {
          if (markup.type !== 'cloud') {
            ctx.closePath();
          }
        }
        
        if (m.style.fillColor !== 'transparent' || isEraserHovered) {
          ctx.fill();
        }
        if (m.aiRun) {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
        }
        ctx.stroke();
        // Home runs: arrow + conductor tick marks at the panel end (Revit home-run symbol).
        if (m.aiRun?.kind === 'homerun') drawRunArrow(ctx, m);
        if (m.aiRun?.kind === 'homerun' && m.label) drawRunLabel(ctx, m);
        break;
      }
      
      case 'text':
      case 'callout': {
        const m = markup as TextMarkup;
        const fontSize = m.style.fontSize || 12;
        ctx.font = `${fontSize}px ${m.style.fontFamily || 'Arial'}`;
        
        if (markup.type === 'callout' && m.leaderPoints) {
          ctx.beginPath();
          ctx.moveTo(m.leaderPoints[0].x, m.leaderPoints[0].y);
          for (let i = 1; i < m.leaderPoints.length; i++) {
            ctx.lineTo(m.leaderPoints[i].x, m.leaderPoints[i].y);
          }
          ctx.stroke();
        }
        
        // Draw text box background
        const fill =
          isEraserHovered
            ? 'rgba(239, 68, 68, 0.3)'
            : m.style.fillColor && m.style.fillColor !== 'transparent'
              ? m.style.fillColor
              : 'rgba(255, 255, 255, 0.9)';
        ctx.fillStyle = fill;
        ctx.fillRect(m.x, m.y, m.width, m.height);
        ctx.strokeRect(m.x, m.y, m.width, m.height);
        
        // Clip text to box boundaries
        ctx.save();
        ctx.beginPath();
        ctx.rect(m.x, m.y, m.width, m.height);
        ctx.clip();
        
        // Word-wrap and draw text
        ctx.fillStyle = isEraserHovered ? '#ef4444' : m.style.strokeColor;
        const padding = 5;
        const lineHeight = fontSize * 1.2;
        const maxWidth = m.width - padding * 2;
        const text = m.content || '';
        
        // Split into lines (handle manual line breaks and word wrap)
        const paragraphs = text.split('\n');
        const wrappedLines: string[] = [];
        
        for (const paragraph of paragraphs) {
          if (paragraph === '') {
            wrappedLines.push('');
            continue;
          }
          const words = paragraph.split(' ');
          let currentLine = '';
          
          for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const metrics = ctx.measureText(testLine);
            
            if (metrics.width > maxWidth && currentLine) {
              wrappedLines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = testLine;
            }
          }
          
          if (currentLine) {
            wrappedLines.push(currentLine);
          }
        }
        
        // Draw each line, respecting vertical bounds
        let y = m.y + fontSize + padding;
        for (const line of wrappedLines) {
          if (y > m.y + m.height - padding) break;
          ctx.fillText(line, m.x + padding, y);
          y += lineHeight;
        }
        
        ctx.restore(); // Remove clipping
        break;
      }
      
      case 'stamp': {
        const m = markup as StampMarkup;
        const preset = STAMP_PRESETS[m.preset];
        
        // Draw stamp background
        ctx.fillStyle = isEraserHovered ? 'rgba(239, 68, 68, 0.3)' : preset.bgColor;
        ctx.strokeStyle = isEraserHovered ? '#ef4444' : preset.color;
        ctx.lineWidth = 3;
        
        // Rounded rectangle
        const radius = 8;
        ctx.beginPath();
        ctx.roundRect(m.x, m.y, m.width, m.height, radius);
        ctx.fill();
        ctx.stroke();
        
        // Inner border
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(m.x + 4, m.y + 4, m.width - 8, m.height - 8, radius - 2);
        ctx.stroke();
        
        // Text
        ctx.fillStyle = isEraserHovered ? '#ef4444' : preset.color;
        ctx.font = `bold ${(m.height - 16) * 0.5}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(preset.label, m.x + m.width / 2, m.y + m.height / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        break;
      }
      
      case 'count-marker': {
        const m = markup as CountMarkerMarkup;
        const radius = 10;
        
        // Simple dot marker (no number)
        ctx.fillStyle = isEraserHovered ? 'rgba(239, 68, 68, 0.8)' : markup.style.strokeColor;
        ctx.beginPath();
        ctx.arc(m.x, m.y, radius, 0, Math.PI * 2);
        ctx.fill();
        
        // Add a subtle border for visibility
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.stroke();

        // Pending confirmation: emerald dashed halo (matches ApprovalCard accents).
        if (pendingAppearance.pendingBadge && !isEraserHovered) {
          ctx.setLineDash(pendingAppearance.lineDash);
          ctx.strokeStyle = pendingAppearance.strokeStyle || '#10b981';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(m.x, m.y, radius + 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        const caption = countMarkerCaption(markup);
        if (caption) {
          // Review markers draw an amber dot; the "?" must contrast with it.
          ctx.fillStyle = caption === '?' ? '#ffffff' : (pendingAppearance.strokeStyle || markup.style.strokeColor);
          ctx.font = 'bold 12px Arial';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(caption, m.x, m.y);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
        }
        break;
      }
      
      case 'measurement-length':
      case 'measurement-area': {
        const m = markup as any;
        if (m.points.length < 2) break;
        
        ctx.strokeStyle = isEraserHovered ? '#ef4444' : '#22c55e';
        ctx.fillStyle = isEraserHovered ? '#ef4444' : '#22c55e';
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        ctx.moveTo(m.points[0].x, m.points[0].y);
        for (let i = 1; i < m.points.length; i++) {
          ctx.lineTo(m.points[i].x, m.points[i].y);
        }
        
        if (markup.type === 'measurement-area') {
          ctx.closePath();
          ctx.fillStyle = isEraserHovered ? 'rgba(239, 68, 68, 0.2)' : 'rgba(34, 197, 94, 0.1)';
          ctx.fill();
        }
        ctx.stroke();
        
        // Draw measurement label
        const midX = (m.points[0].x + m.points[m.points.length - 1].x) / 2;
        const midY = (m.points[0].y + m.points[m.points.length - 1].y) / 2;
        
        ctx.fillStyle = isEraserHovered ? '#ef4444' : '#22c55e';
        ctx.fillRect(midX - 30, midY - 12, 60, 20);
        ctx.fillStyle = 'white';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${m.scaledValue.toFixed(2)} ${m.unit}`, midX, midY + 4);
        ctx.textAlign = 'left';
        break;
      }
    }
    
    // Draw selection handles
    if (isSelected && !isEraserHovered) {
      ctx.shadowBlur = 0;
      drawSelectionHandles(ctx, markup);
    }
    
    ctx.restore();
  };

  // Home-run tag at the middle of the longest segment (constant on-screen size)
  /** Filled tag (white text) above-left of an anchor, sized in paper units. */
  const drawPaperTag = (ctx: CanvasRenderingContext2D, text: string, at: Point, color: string, fontSize: number) => {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    const pad = fontSize * 0.35;
    const w = ctx.measureText(text).width + pad * 2;
    const h = fontSize + pad * 1.4;
    ctx.fillStyle = color;
    ctx.fillRect(at.x, at.y - h, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, at.x + pad, at.y - h / 2);
    ctx.restore();
  };

  /**
   * Home-run tag drawn like a Revit callout: a boxed tag beside the run with a leader to it. Sized
   * in paper units (scales with the print when zooming, like the drawing's own text).
   */
  const drawRunLabel = (ctx: CanvasRenderingContext2D, m: PolygonMarkup) => {
    if (m.points.length < 2) return;
    // Anchor ~35% along the run from the fixture end.
    const segs = m.points.slice(1).map((p, i) => Math.hypot(p.x - m.points[i].x, p.y - m.points[i].y));
    const total = segs.reduce((x, y) => x + y, 0);
    let target = total * 0.35;
    let i = 0;
    while (i < segs.length - 1 && target > segs[i]) { target -= segs[i]; i += 1; }
    const a = m.points[i];
    const b = m.points[i + 1];
    const t = segs[i] > 0 ? target / segs[i] : 0;
    const anchor = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const sw = Math.max(0.8, m.style.strokeWidth);
    const fontSize = sw * 3.6;
    const raw = m.label || '';
    const split = raw.indexOf(': ');
    const line1 = split > 0 ? raw.slice(0, split) : raw;
    const line2 = split > 0 ? raw.slice(split + 2) : '';
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = `700 ${fontSize}px Inter, sans-serif`;
    const w1 = ctx.measureText(line1).width;
    ctx.font = `500 ${fontSize * 0.85}px Inter, sans-serif`;
    const w2 = line2 ? ctx.measureText(line2).width : 0;
    const pad = fontSize * 0.4;
    const w = Math.max(w1, w2) + pad * 2;
    const h = fontSize * (line2 ? 2.1 : 1.1) + pad * 1.2;
    // Offset perpendicular to the run (upper side), leader back to the anchor.
    const segLen = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
    let nx = -(b.y - a.y) / segLen;
    let ny = (b.x - a.x) / segLen;
    if (ny > 0 || (ny === 0 && nx > 0)) { nx = -nx; ny = -ny; }
    const gap = fontSize * 2.4;
    const cx = anchor.x + nx * (gap + (Math.abs(nx) > 0.7 ? w / 2 : 0));
    const cy = anchor.y + ny * (gap + (Math.abs(ny) > 0.7 ? h / 2 : 0));
    const bx = cx - w / 2;
    const by = cy - h / 2;
    // Leader: anchor dot → nearest point on the tag box.
    const lx = Math.max(bx, Math.min(anchor.x, bx + w));
    const ly = Math.max(by, Math.min(anchor.y, by + h));
    ctx.strokeStyle = m.style.strokeColor;
    ctx.lineWidth = sw * 0.45;
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.fillStyle = m.style.strokeColor;
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, sw * 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillRect(bx, by, w, h);
    ctx.lineWidth = sw * 0.45;
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = '#0b5c99';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${fontSize}px Inter, sans-serif`;
    ctx.fillText(line1, bx + pad, by + pad * 0.6);
    if (line2) {
      ctx.font = `500 ${fontSize * 0.85}px Inter, sans-serif`;
      ctx.fillStyle = '#1f2937';
      ctx.fillText(line2, bx + pad, by + pad * 0.6 + fontSize * 1.15);
    }
    ctx.restore();
  };

  /** Arrowhead + conductor tick marks at the panel end of a home run (paper units). */
  const drawRunArrow = (ctx: CanvasRenderingContext2D, m: PolygonMarkup) => {
    const n = m.points.length;
    if (n < 2) return;
    const tip = m.points[n - 1];
    let from = m.points[n - 2];
    for (let i = n - 2; i >= 0 && Math.hypot(tip.x - from.x, tip.y - from.y) < 1e-3; i -= 1) from = m.points[i];
    const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
    const sw = Math.max(0.8, m.style.strokeWidth);
    const head = sw * 5;
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.fillStyle = m.style.strokeColor;
    ctx.strokeStyle = m.style.strokeColor;
    {
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - head * Math.cos(angle - Math.PI / 7), tip.y - head * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(tip.x - head * Math.cos(angle + Math.PI / 7), tip.y - head * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    }
    // Ticks: long = hot, short = neutral, long with a dot = ground (per Revit wiring tags).
    const segLen = Math.hypot(tip.x - from.x, tip.y - from.y);
    const circuits = Math.max(1, m.aiRun?.circuits?.length || 1);
    const ticks: Array<'hot' | 'neutral' | 'ground'> = [];
    for (let c = 0; c < circuits; c += 1) ticks.push('hot');
    for (let c = 0; c < circuits; c += 1) ticks.push('neutral');
    ticks.push('ground');
    const spacing = sw * 1.8;
    const start = head * 1.6;
    if (segLen > start + spacing * ticks.length) {
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const px = -uy;
      const py = ux;
      ctx.lineWidth = sw * 0.6;
      ticks.forEach((kind, i) => {
        const d = start + i * spacing;
        const cx = tip.x - ux * d;
        const cy = tip.y - uy * d;
        const len = kind === 'neutral' ? sw * 1.6 : sw * 2.8;
        ctx.beginPath();
        ctx.moveTo(cx - px * len * 0.2 - ux * len * 0.3, cy - py * len * 0.2 - uy * len * 0.3);
        ctx.lineTo(cx + px * len + ux * len * 0.3, cy + py * len + uy * len * 0.3);
        ctx.stroke();
        if (kind === 'ground') {
          ctx.beginPath();
          ctx.arc(cx + px * len + ux * len * 0.3, cy + py * len + uy * len * 0.3, sw * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }
    ctx.restore();
  };

  const drawSelectionHandles = (ctx: CanvasRenderingContext2D, markup: CanvasMarkup) => {
    ctx.fillStyle = '#3b82f6';
    ctx.strokeStyle = 'white';
    const scale = zoom / 100;
    ctx.lineWidth = 1 / scale; // Adjust for zoom
    
    const handleSize = 6 / scale; // Keep handles visually consistent regardless of zoom
    const drawHandle = (x: number, y: number) => {
      ctx.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
    };
    
    if ('x' in markup && 'width' in markup && (markup as any).type !== 'count-marker') {
      const m = markup as RectangleMarkup;
      drawHandle(m.x, m.y);
      drawHandle(m.x + m.width, m.y);
      drawHandle(m.x, m.y + m.height);
      drawHandle(m.x + m.width, m.y + m.height);
      drawHandle(m.x + m.width / 2, m.y);
      drawHandle(m.x + m.width / 2, m.y + m.height);
      drawHandle(m.x, m.y + m.height / 2);
      drawHandle(m.x + m.width, m.y + m.height / 2);
    }
    
    if ('startX' in markup) {
      const m = markup as LineMarkup;
      drawHandle(m.startX, m.startY);
      drawHandle(m.endX, m.endY);
    }
    
    if ('points' in markup && markup.type !== 'measurement-length' && markup.type !== 'measurement-area') {
      const m = markup as PolygonMarkup;
      m.points.forEach((p) => drawHandle(p.x, p.y));
    }
    
    if (markup.type === 'count-marker') {
      const m = markup as CountMarkerMarkup;
      drawHandle(m.x, m.y);
    }
  };

  // Draw preview - points are in PDF space, need to transform for display
  const drawPreview = (
    ctx: CanvasRenderingContext2D,
    tool: string,
    points: Point[],
    style: typeof defaultStyle
  ) => {
    if (points.length === 0) return;
    
    ctx.save();
    
    // Preview points are in PDF space; CSS transform handles zoom
    
    ctx.strokeStyle = style.strokeColor;
    ctx.fillStyle = style.fillColor === 'transparent' ? 'transparent' : style.fillColor + '40';
    ctx.lineWidth = style.strokeWidth;
    ctx.setLineDash([5, 5]);
    
    const startPoint = points[0];
    const endPoint = points[points.length - 1];
    
    switch (tool) {
      case 'rectangle':
      case 'text':
        ctx.strokeRect(
          startPoint.x,
          startPoint.y,
          endPoint.x - startPoint.x,
          endPoint.y - startPoint.y
        );
        break;
        
      case 'highlight':
        // Highlight preview with yellow fill
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(253, 224, 71, 0.35)'; // Yellow with transparency
        ctx.fillRect(
          Math.min(startPoint.x, endPoint.x),
          Math.min(startPoint.y, endPoint.y),
          Math.abs(endPoint.x - startPoint.x),
          Math.abs(endPoint.y - startPoint.y)
        );
        break;
        
      case 'ellipse':
        const w = endPoint.x - startPoint.x;
        const h = endPoint.y - startPoint.y;
        ctx.beginPath();
        ctx.ellipse(
          startPoint.x + w / 2,
          startPoint.y + h / 2,
          Math.abs(w / 2),
          Math.abs(h / 2),
          0, 0, Math.PI * 2
        );
        ctx.stroke();
        break;
        
      case 'line':
      case 'arrow':
        ctx.beginPath();
        ctx.moveTo(startPoint.x, startPoint.y);
        ctx.lineTo(endPoint.x, endPoint.y);
        ctx.stroke();
        if (tool === 'arrow') {
          const angle = Math.atan2(endPoint.y - startPoint.y, endPoint.x - startPoint.x);
          const headLength = 12;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(endPoint.x, endPoint.y);
          ctx.lineTo(
            endPoint.x - headLength * Math.cos(angle - Math.PI / 6),
            endPoint.y - headLength * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(
            endPoint.x - headLength * Math.cos(angle + Math.PI / 6),
            endPoint.y - headLength * Math.sin(angle + Math.PI / 6)
          );
          ctx.closePath();
          ctx.fill();
        }
        break;
        
      case 'freehand':
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.stroke();
        break;
        
      case 'polyline':
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.stroke();
        // Draw vertex dots at confirmed points (all except last which is preview)
        ctx.setLineDash([]);
        ctx.fillStyle = style.strokeColor;
        points.slice(0, -1).forEach((p) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
        break;
        
      case 'cloud':
        // Cloud preview with scalloped edges
        if (points.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) {
            drawCloudEdge(ctx, points[i - 1], points[i], true);
          }
          // Close with scalloped edge
          drawCloudEdge(ctx, points[points.length - 1], points[0], true);
          ctx.stroke();
        }
        // Draw vertex dots at confirmed points
        ctx.setLineDash([]);
        ctx.fillStyle = style.strokeColor;
        points.slice(0, -1).forEach((p) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
        break;
        
      case 'polygon':
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        points.forEach((p) => ctx.lineTo(p.x, p.y));
        ctx.closePath(); // Close back to first point for polygon preview
        ctx.stroke();
        // Draw vertex dots at confirmed points
        ctx.setLineDash([]);
        ctx.fillStyle = style.strokeColor;
        points.slice(0, -1).forEach((p) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fill();
        });
        break;
        
      case 'callout':
        const boxX = Math.min(startPoint.x, endPoint.x);
        const boxY = Math.min(startPoint.y, endPoint.y);
        const boxW = Math.abs(endPoint.x - startPoint.x);
        const boxH = Math.abs(endPoint.y - startPoint.y);
        // Leader line
        ctx.beginPath();
        ctx.moveTo(startPoint.x - 20, startPoint.y - 20);
        ctx.lineTo(startPoint.x, startPoint.y);
        ctx.stroke();
        // Box
        ctx.strokeRect(boxX, boxY, boxW, boxH);
        break;
        
      case 'measure-length':
        ctx.strokeStyle = '#22c55e';
        ctx.beginPath();
        ctx.moveTo(startPoint.x, startPoint.y);
        ctx.lineTo(endPoint.x, endPoint.y);
        ctx.stroke();
        
        const dist = Math.sqrt(
          Math.pow(endPoint.x - startPoint.x, 2) +
          Math.pow(endPoint.y - startPoint.y, 2)
        );
        const scaledDist = dist / measureScale;
        
        ctx.setLineDash([]);
        ctx.fillStyle = '#22c55e';
        ctx.font = '11px monospace';
        ctx.fillText(
          `${scaledDist.toFixed(2)} ${measureUnit}`,
          (startPoint.x + endPoint.x) / 2 + 10,
          (startPoint.y + endPoint.y) / 2 - 10
        );
        break;
        
      case 'measure-area':
        ctx.strokeStyle = '#22c55e';
        ctx.fillStyle = 'rgba(34, 197, 94, 0.1)';
        const areaMinX = Math.min(startPoint.x, endPoint.x);
        const areaMinY = Math.min(startPoint.y, endPoint.y);
        const areaW = Math.abs(endPoint.x - startPoint.x);
        const areaH = Math.abs(endPoint.y - startPoint.y);
        ctx.fillRect(areaMinX, areaMinY, areaW, areaH);
        ctx.strokeRect(areaMinX, areaMinY, areaW, areaH);
        
        const areaPixels = areaW * areaH;
        const scaledArea = areaPixels / (measureScale * measureScale);
        const areaUnit = measureUnit === 'ft' ? 'sq ft' : `sq ${measureUnit}`;
        
        ctx.setLineDash([]);
        ctx.fillStyle = '#22c55e';
        ctx.font = '11px monospace';
        ctx.fillText(
          `${scaledArea.toFixed(2)} ${areaUnit}`,
          areaMinX + areaW / 2 - 30,
          areaMinY + areaH / 2
        );
        break;
        
      case 'stamp':
        // Preview stamp with selected preset
        const selectedPreset = useEditorStore.getState().selectedStamp || 'approved';
        const preset = STAMP_PRESETS[selectedPreset];
        const stampW = 120;
        const stampH = 40;
        ctx.setLineDash([]);
        ctx.fillStyle = preset.bgColor;
        ctx.strokeStyle = preset.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.roundRect(startPoint.x - stampW / 2, startPoint.y - stampH / 2, stampW, stampH, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = preset.color;
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(preset.label, startPoint.x, startPoint.y);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        break;
    }
    
    ctx.restore();
  };

  useEffect(() => {
    if (!isPicking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useDrawingPickStore.getState().cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPicking]);

  // Get mouse position in PDF coordinate space (independent of zoom/pan/rotation)
  const getMousePosition = (e: MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const scale = zoom / 100;
    const angleRad = (rotation * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    // Coordinates relative to center in screen space
    const dx = e.clientX - centerX;
    const dy = e.clientY - centerY;

    // Undo rotation, then undo scale
    const localX = (dx * cos + dy * sin) / scale;
    const localY = (-dx * sin + dy * cos) / scale;

    // Convert to PDF space (origin at top-left)
    return {
      x: localX + width / 2,
      y: localY + height / 2,
    };
  };

  // Page geometry for display-percent <-> doc conversion (falls back to the canvas size, unrotated).
  function pickGeometry(pageNumber: number) {
    const cached = useCanvasStore.getState().getPageGeometry(pageNumber);
    return pageGeometryFromUnrotated({
      pageNumber,
      docWidth: cached?.docWidth || width,
      docHeight: cached?.docHeight || height,
      rotationDeg: cached?.rotationDeg ?? 0,
    });
  }

  const handleContextMenu = (e: MouseEvent<HTMLCanvasElement>) => {
    if (isPanMode) return;
    const rawPoint = getMousePosition(e);
    const point = (activeTool === 'freehand' || !snapToObjects)
      ? rawPoint
      : getSnappedPoint(rawPoint);

    const markup = findMarkupAtPoint(point);
    if (!markup || markup.type !== 'count-marker') {
      setCountMenu(null);
      return;
    }

    e.preventDefault();
    const countMarkup = markup as CountMarkerMarkup;
    setCountMenu({
      x: e.clientX,
      y: e.clientY,
      markupId: countMarkup.id,
      groupId: countMarkup.groupId,
      productId: countMarkup.productId,
    });
  };

  const handleResumeCount = () => {
    if (!countMenu) return;

    setActiveCountGroup(countMenu.groupId);
    if (countMenu.productId) {
      setActiveProduct(countMenu.productId);
    }
    setCountMenu(null);
  };

  const handleSplitCount = () => {
    if (!countMenu) return;

    const groupId = countMenu.groupId;
    const groupMarkers = markups
      .filter((m) => m.type === 'count-marker' && (m as CountMarkerMarkup).groupId === groupId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) as CountMarkerMarkup[];

    const splitIndex = groupMarkers.findIndex((m) => m.id === countMenu.markupId);
    if (splitIndex < 0) return;

    const newGroupId = `${groupId}-split-${Date.now()}`;
    const newMarkers = groupMarkers.slice(splitIndex);
    const newMarkerIds = new Set(newMarkers.map((m) => m.id));

    // Move markers from split point onward to new group
    const updatedMarkups = markups.map((m) => {
      if (m.type !== 'count-marker') return m;
      const count = m as CountMarkerMarkup;
      if (count.groupId !== groupId) return m;
      if (newMarkerIds.has(count.id)) {
        return { ...count, groupId: newGroupId };
      }
      return count;
    });

    useHistoryStore.getState().pushHistory({
      action: 'update',
      page: currentPage,
      before: markups,
      after: updatedMarkups,
      description: 'Split count group',
    });

    setMarkupsForPage(currentPage, updatedMarkups);
    setActiveCountGroup(newGroupId);
    setCountMenu(null);
  };

  const handleDeleteCount = () => {
    if (!countMenu) return;
    deleteMarkups(currentPage, [countMenu.markupId]);
    setCountMenu(null);
  };

  // Find markup at a point (point is in PDF space, markups are in PDF space)
  const findMarkupAtPoint = (point: Point): CanvasMarkup | null => {
    // Tolerance adjusted for zoom - smaller tolerance at higher zoom
    const tolerance = 10 / (zoom / 100);
    
    // Search in reverse order (top to bottom)
    for (let i = markups.length - 1; i >= 0; i--) {
      const markup = markups[i];
      
      if (markup.type === 'count-marker') {
        const m = markup as CountMarkerMarkup;
        const radius = 15 / (zoom / 100); // Adjust radius for zoom
        const dist = Math.sqrt(Math.pow(point.x - m.x, 2) + Math.pow(point.y - m.y, 2));
        if (dist <= radius) return markup;
        continue;
      }
      
      if ('x' in markup && 'width' in markup) {
        const m = markup as RectangleMarkup;
        if (
          point.x >= m.x && point.x <= m.x + m.width &&
          point.y >= m.y && point.y <= m.y + m.height
        ) {
          return markup;
        }
      }
      
      if ('startX' in markup) {
        const m = markup as LineMarkup;
        const dist = distanceToLine(point, { x: m.startX, y: m.startY }, { x: m.endX, y: m.endY });
        if (dist < tolerance) return markup;
      }
      
      if ('points' in markup && (markup as any).type !== 'count-marker') {
        const m = markup as PolygonMarkup;
        // Check bounding box for polygon-type markups
        if (m.points.length > 0) {
          const xs = m.points.map(p => p.x);
          const ys = m.points.map(p => p.y);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          const padding = 5 / (zoom / 100);
          if (point.x >= minX - padding && point.x <= maxX + padding && point.y >= minY - padding && point.y <= maxY + padding) {
            return markup;
          }
        }
      }
    }
    
    return null;
  };

  // Suggested runs: re-size conductors / conduit / VD after their geometry changes
  const refreshRunMarkup = (id: string) => {
    const canvasState = useCanvasStore.getState();
    const latest = (canvasState.getMarkupsByPage(canvasState.activeDocId || undefined)[currentPage] || [])
      .find(m => m.id === id);
    if (!latest || !isRunMarkup(latest)) return;
    const next = recomputeRunMarkup(latest);
    if (next) {
      updateMarkup(currentPage, id, { label: next.label, aiNote: next.aiNote, aiRun: next.aiRun } as Partial<CanvasMarkup>);
      // Keep the linked product's footage in step with the edited run.
      if (next.aiRun?.lengthFt != null) useProductStore.getState().updateMeasurementValueByMarkupId(id, runProductFeet(next.aiRun.assembly, next.aiRun.lengthFt));
    }
  };

  const followMovedFixtures = (ids: string[]) => {
    if (!ids.length) return;
    const canvasState = useCanvasStore.getState();
    const pageMarkups = canvasState.getMarkupsByPage(canvasState.activeDocId || undefined)[currentPage] || [];
    for (const row of followAnchoredRuns(pageMarkups, ids)) {
      updateMarkup(currentPage, row.id, row.updates);
      const latest = (row.updates as Partial<CanvasMarkup> & { aiRun?: AiRunMeta }).aiRun;
      if (row.lengthFt != null) {
        useProductStore.getState().updateMeasurementValueByMarkupId(row.id, runProductFeet(latest?.assembly, row.lengthFt));
      }
    }
  };

  const nearestSegmentIndex = (pts: Point[], p: Point): number | null => {
    const tolerance = 8 / (zoom / 100);
    let best: { i: number; d: number } | null = null;
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2)) : 0;
      const d = Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y)));
      if (d <= tolerance && (!best || d < best.d)) best = { i, d };
    }
    return best ? best.i : null;
  };

  // Check if a point is on a resize handle (point is in PDF space)
  const getResizeHandle = (point: Point, markup: CanvasMarkup): ResizeHandle | null => {
    const handleSize = 10 / (zoom / 100); // Adjust handle hit area for zoom
    
    const isNearPoint = (px: number, py: number) => 
      Math.abs(point.x - px) <= handleSize && Math.abs(point.y - py) <= handleSize;
    
    // Rectangle-like markups (rectangle, ellipse, text, stamp, highlight)
    if ('x' in markup && 'width' in markup && (markup as any).type !== 'count-marker') {
      const m = markup as RectangleMarkup;
      
      // Corner handles
      if (isNearPoint(m.x, m.y)) return 'nw';
      if (isNearPoint(m.x + m.width, m.y)) return 'ne';
      if (isNearPoint(m.x, m.y + m.height)) return 'sw';
      if (isNearPoint(m.x + m.width, m.y + m.height)) return 'se';
      
      // Edge handles
      if (isNearPoint(m.x + m.width / 2, m.y)) return 'n';
      if (isNearPoint(m.x + m.width / 2, m.y + m.height)) return 's';
      if (isNearPoint(m.x, m.y + m.height / 2)) return 'w';
      if (isNearPoint(m.x + m.width, m.y + m.height / 2)) return 'e';
    }
    
    // Line markups (line, arrow)
    if ('startX' in markup) {
      const m = markup as LineMarkup;
      if (isNearPoint(m.startX, m.startY)) return 'start';
      if (isNearPoint(m.endX, m.endY)) return 'end';
    }

    // Vertex handles (polyline / polygon / cloud) — drag any point
    if ((markup.type === 'polyline' || markup.type === 'polygon' || markup.type === 'cloud') && 'points' in markup) {
      const pts = (markup as PolygonMarkup).points;
      for (let i = 0; i < pts.length; i += 1) {
        if (isNearPoint(pts[i].x, pts[i].y)) return `v${i}`;
      }
    }
    
    return null;
  };

  // Get the resize cursor based on handle
  const getResizeCursor = (handle: ResizeHandle | null): string => {
    switch (handle) {
      case 'nw':
      case 'se':
        return 'nwse-resize';
      case 'ne':
      case 'sw':
        return 'nesw-resize';
      case 'n':
      case 's':
        return 'ns-resize';
      case 'e':
      case 'w':
        return 'ew-resize';
      case 'start':
      case 'end':
        return 'move';
      default:
        return handle && vertexIndexOf(handle) !== null ? 'move' : 'default';
    }
  };

  const distanceToLine = (point: Point, lineStart: Point, lineEnd: Point): number => {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;
    
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    
    if (lenSq !== 0) param = dot / lenSq;
    
    let xx, yy;
    
    if (param < 0) {
      xx = lineStart.x;
      yy = lineStart.y;
    } else if (param > 1) {
      xx = lineEnd.x;
      yy = lineEnd.y;
    } else {
      xx = lineStart.x + param * C;
      yy = lineStart.y + param * D;
    }
    
    const dx = point.x - xx;
    const dy = point.y - yy;
    
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleMouseDown = (e: MouseEvent<HTMLCanvasElement>) => {
    if (countMenu) {
      setCountMenu(null);
    }
    const rawPoint = getMousePosition(e);
    if (isPicking && pickRequest?.mode === 'area') {
      setAreaDrag({ start: rawPoint, current: rawPoint });
      return;
    }
    if (isPicking) {
      // Answering an AI question: "click the panel on the drawing".
      const geometry = pickGeometry(currentPage);
      const identity = { ...geometry, renderScale: 1 };
      const display = docToRender(rawPoint, identity);
      const size = getRenderPageSize(identity);
      const clamp = (v: number) => Math.max(0, Math.min(100, v));
      useDrawingPickStore.getState().complete({
        documentId: activeDocId || undefined,
        page: currentPage,
        xPct: Math.round(clamp((display.x / size.width) * 100) * 10) / 10,
        yPct: Math.round(clamp((display.y / size.height) * 100) * 10) / 10,
      });
      return;
    }
    // Only apply snapping when "Snap to Objects" is enabled
    // Freehand always bypasses snapping for fluid strokes
    const point = (activeTool === 'freehand' || !snapToObjects) 
      ? rawPoint 
      : getSnappedPoint(rawPoint);
    
    // Clear snap indicator when not snapping
    if (activeTool === 'freehand' || !snapToObjects) {
      setActiveSnapPoint(null);
    }
    
    // Handle calibration mode
    if (calibration.isCalibrating) {
      if (!calibration.point1) {
        setCalibrationPoint(point, true);
      } else if (!calibration.point2) {
        setCalibrationPoint(point, false);
      }
      return;
    }
    
    // Handle highlight tool with text selection (if OCR completed)
    if (activeTool === 'highlight') {
      const ocrStatus = getOcrStatus();
      const words = getTextWords(currentPage);
      
      // If OCR completed and we have words, use text selection mode
      if (ocrStatus.status === 'completed' && words.length > 0) {
        const clickedWord = findWordAtPoint(words, point);
        
        if (clickedWord) {
          // Start text selection
          setHighlightSelection({
            startWord: clickedWord,
            currentWord: clickedWord,
            selectedWords: [clickedWord],
          });
          return;
        }
      }
      // Fall through to normal rectangle drawing if no text clicked or OCR not done
    }
    
    // Handle eraser tool
    if (activeTool === 'eraser') {
      const markup = findMarkupAtPoint(point);
      if (markup) {
        deleteMarkups(currentPage, [markup.id]);
      }
      return;
    }
    
    // Handle stamp tool - place stamp on click
    if (activeTool === 'stamp') {
      const selectedPreset = useEditorStore.getState().selectedStamp || 'approved';
      const stampW = 120;
      const stampH = 40;
      
      const newStamp: StampMarkup = {
        id: `stamp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'stamp',
        page: currentPage,
        style: { ...defaultStyle },
        locked: false,
        author: 'Current User',
        createdAt: new Date().toISOString(),
        x: point.x - stampW / 2,
        y: point.y - stampH / 2,
        width: stampW,
        height: stampH,
        preset: selectedPreset,
      };
      
      addMarkup(currentPage, newStamp);
      return;
    }
    
    // Handle count tool
    if (activeTool === 'count') {
      // Simple group ID based on product or page
      const groupId = activeCountGroupId
        || (activeProductId ? `count-product-${activeProductId}` : `count-page-${currentPage}`);
      
      const newMarker: CountMarkerMarkup = {
        id: `count-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'count-marker',
        page: currentPage,
        style: activeProductId ? { ...defaultStyle, ...productMarkerColor(activeProductId) } : { ...defaultStyle },
        locked: false,
        author: 'Current User',
        createdAt: new Date().toISOString(),
        x: point.x,
        y: point.y,
        number: 0, // Number not displayed, kept for compatibility
        groupId,
        productId: activeProductId || undefined,
      };
      
      addMarkup(currentPage, newMarker);
      
      // Auto-link count to active product
      if (activeProductId && activeDocId) {
        linkMeasurement(activeProductId, {
          markupId: newMarker.id,
          documentId: activeDocId,
          page: currentPage,
          type: 'count',
          value: 1,
          unit: 'ea',
        });
      }
      
      return;
    }
    
    // Handle selection tool
    if (activeTool === 'select') {
      const markup = findMarkupAtPoint(point);
      
      // Check if clicking on a resize handle of an already-selected markup
      for (const id of selectedMarkupIds) {
        const selectedMarkup = markups.find(m => m.id === id);
        if (selectedMarkup) {
          const handle = getResizeHandle(point, selectedMarkup);
          if (handle) {
            // Start resizing
            setResizing({
              handle,
              startX: point.x,
              startY: point.y,
              originalMarkup: JSON.parse(JSON.stringify(selectedMarkup)),
            });
            beginEditorInteraction();
            return;
          }
        }
      }
      
      // Double-click a selected polyline segment to add a bend point
      if (markup && e.detail === 2 && markup.type === 'polyline' && selectedMarkupIds.includes(markup.id)) {
        const pts = (markup as PolygonMarkup).points;
        const at = nearestSegmentIndex(pts, point);
        if (at !== null) {
          const next = [...pts.slice(0, at + 1), { x: point.x, y: point.y }, ...pts.slice(at + 1)];
          updateMarkup(currentPage, markup.id, { points: next } as Partial<CanvasMarkup>);
          refreshRunMarkup(markup.id);
          return;
        }
      }

      if (markup) {
        // Double-click to edit text
        if (e.detail === 2 && (markup.type === 'text' || markup.type === 'callout')) {
          setEditingTextMarkup(markup as TextMarkup);
          return;
        }

        // Select only the clicked marker (count markers are individually selectable)
        selectMarkup(markup.id, e.shiftKey);
        if (typeof markup.calloutRef === 'number') {
          window.dispatchEvent(new CustomEvent('bidveraai:highlight-callout-ref', {
            detail: {
              ref: markup.calloutRef,
              messageId: markup.messageId,
              markupId: markup.id,
              page: markup.page,
            },
          }));
        }
        setIsDragging(true);
        beginEditorInteraction();
        setDragStart(point);
        
        if ('x' in markup) {
          setDragOffset({ x: point.x - (markup as any).x, y: point.y - (markup as any).y });
        }
      } else {
        clearSelection();
      }
      return;
    }
    
    // Handle polyline and polygon tools - click to add vertices
    if (activeTool === 'polyline' || activeTool === 'polygon' || activeTool === 'cloud') {
      if (drawing.isDrawing) {
        // Already drawing - check for double-click to complete
        if (e.detail === 2) {
          completePolygonDrawing();
          return;
        }
        // Single click: add new point (keep existing points + add new confirmed point + preview point)
        useCanvasStore.setState((state) => ({
          drawing: {
            ...state.drawing,
            currentPoints: [...state.drawing.currentPoints.slice(0, -1), point, point] // Replace preview with confirmed + new preview
          }
        }));
      } else {
        // First click: start drawing with initial point + preview point
        startDrawing(point);
        useCanvasStore.setState((state) => ({
          drawing: {
            ...state.drawing,
            currentPoints: [point, point] // First confirmed point + preview point
          }
        }));
      }
      return;
    }
    
    // Start drawing for other tools
    const drawTools = [
      'rectangle', 'ellipse', 'line', 'arrow',
      'highlight', 'freehand', 'text', 'callout',
      'measure-length', 'measure-area'
    ];
    if (drawTools.includes(activeTool)) {
      startDrawing(point);
    }
  };

  const handleMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const rawPoint = getMousePosition(e);
    if (areaDrag) {
      setAreaDrag({ start: areaDrag.start, current: rawPoint });
      return;
    }
    // Only apply snapping when "Snap to Objects" is enabled
    // Freehand always bypasses snapping for fluid strokes
    const point = (activeTool === 'freehand' || !snapToObjects) 
      ? rawPoint 
      : getSnappedPoint(rawPoint);
    
    // Clear snap indicator when not snapping
    if (activeTool === 'freehand' || !snapToObjects) {
      setActiveSnapPoint(null);
    }
    
    // Handle eraser hover effect
    if (activeTool === 'eraser') {
      const markup = findMarkupAtPoint(point);
      setEraserHoveredId(markup?.id || null);
    } else {
      setEraserHoveredId(null);
    }
    
    // Handle highlight text selection (when in text selection mode)
    if (activeTool === 'highlight' && highlightSelection?.startWord) {
      const words = getTextWords(currentPage);
      const hoveredWord = findWordAtPoint(words, point);
      
      if (hoveredWord) {
        const selectedWords = findWordsInRange(words, highlightSelection.startWord, hoveredWord);
        setHighlightSelection(prev => ({
          ...prev!,
          currentWord: hoveredWord,
          selectedWords,
        }));
      }
      return;
    }
    
    // Track if cursor is over text (for cursor change)
    if (activeTool === 'highlight') {
      const ocrStatus = getOcrStatus();
      const words = getTextWords(currentPage);
      if (ocrStatus.status === 'completed' && words.length > 0) {
        const wordAtPoint = findWordAtPoint(words, point);
        setIsOverText(wordAtPoint !== null);
      } else {
        setIsOverText(false);
      }
    } else {
      setIsOverText(false);
    }
    
    // Handle calibration preview
    if (calibration.isCalibrating && calibration.point1 && !calibration.point2) {
      setCalibrationPoint(point, false);
      draw();
      return;
    }
    
    // Handle resizing
    if (resizing) {
      const { handle, originalMarkup } = resizing;
      const dx = point.x - resizing.startX;
      const dy = point.y - resizing.startY;
      const minSize = 20;
      
      if ('x' in originalMarkup && 'width' in originalMarkup && (originalMarkup as any).type !== 'count-marker') {
        const m = originalMarkup as RectangleMarkup;
        let newX = m.x;
        let newY = m.y;
        let newWidth = m.width;
        let newHeight = m.height;
        
        // Handle corner and edge resizing
        switch (handle) {
          case 'nw':
            newX = Math.min(m.x + m.width - minSize, m.x + dx);
            newY = Math.min(m.y + m.height - minSize, m.y + dy);
            newWidth = Math.max(minSize, m.width - dx);
            newHeight = Math.max(minSize, m.height - dy);
            break;
          case 'ne':
            newY = Math.min(m.y + m.height - minSize, m.y + dy);
            newWidth = Math.max(minSize, m.width + dx);
            newHeight = Math.max(minSize, m.height - dy);
            break;
          case 'sw':
            newX = Math.min(m.x + m.width - minSize, m.x + dx);
            newWidth = Math.max(minSize, m.width - dx);
            newHeight = Math.max(minSize, m.height + dy);
            break;
          case 'se':
            newWidth = Math.max(minSize, m.width + dx);
            newHeight = Math.max(minSize, m.height + dy);
            break;
          case 'n':
            newY = Math.min(m.y + m.height - minSize, m.y + dy);
            newHeight = Math.max(minSize, m.height - dy);
            break;
          case 's':
            newHeight = Math.max(minSize, m.height + dy);
            break;
          case 'w':
            newX = Math.min(m.x + m.width - minSize, m.x + dx);
            newWidth = Math.max(minSize, m.width - dx);
            break;
          case 'e':
            newWidth = Math.max(minSize, m.width + dx);
            break;
        }
        
        updateMarkup(currentPage, originalMarkup.id, {
          x: newX,
          y: newY,
          width: newWidth,
          height: newHeight,
        } as any);
      }
      
      // Vertex drag (polyline / polygon / cloud)
      const vertex = vertexIndexOf(handle);
      if (vertex !== null && 'points' in originalMarkup) {
        const pts = (originalMarkup as PolygonMarkup).points.map(p => ({ ...p }));
        if (pts[vertex]) {
          pts[vertex] = { x: pts[vertex].x + dx, y: pts[vertex].y + dy };
          updateMarkup(currentPage, originalMarkup.id, { points: pts } as Partial<CanvasMarkup>);
        }
      }

      // Handle line/arrow resize
      if ('startX' in originalMarkup) {
        const m = originalMarkup as LineMarkup;
        if (handle === 'start') {
          updateMarkup(currentPage, originalMarkup.id, {
            startX: m.startX + dx,
            startY: m.startY + dy,
          } as any);
        } else if (handle === 'end') {
          updateMarkup(currentPage, originalMarkup.id, {
            endX: m.endX + dx,
            endY: m.endY + dy,
          } as any);
        }
      }
      
      return;
    }
    
    // Handle dragging
    if (isDragging && dragStart && selectedMarkupIds.length > 0) {
      const dx = point.x - dragStart.x;
      const dy = point.y - dragStart.y;
      
      selectedMarkupIds.forEach((id) => {
        const markup = markups.find((m) => m.id === id);
        if (!markup) return;
        
        if ('x' in markup && markup.type !== 'count-marker') {
          updateMarkup(currentPage, id, {
            x: point.x - dragOffset.x,
            y: point.y - dragOffset.y,
          } as any);
        }
        
        if (markup.type === 'count-marker') {
          updateMarkup(currentPage, id, {
            x: point.x,
            y: point.y,
          } as any);
        }
      });
      
      setDragStart(point);
      return;
    }
    
    // Handle drawing preview
    if (drawing.isDrawing) {
      let updatedPoints: Point[];
      
      if (activeTool === 'freehand') {
        // Freehand: add all points as user moves
        updatedPoints = [...drawing.currentPoints, point];
      } else if (activeTool === 'polyline' || activeTool === 'polygon' || activeTool === 'cloud') {
        // Polyline/polygon/cloud: keep confirmed points, update only the last preview point
        updatedPoints = [...drawing.currentPoints.slice(0, -1), point];
      } else {
        // Other tools: just start and end point
        updatedPoints = [drawing.currentPoints[0], point];
      }
      
      useCanvasStore.setState((state) => ({
        drawing: { ...state.drawing, currentPoints: updatedPoints }
      }));
    }
    
    // Handle hover detection
    const hoveredMarkup = findMarkupAtPoint(point);
    setHoveredMarkup(hoveredMarkup?.id || null);
    
    // Check for resize handle hover when in select mode
    if (activeTool === 'select' && selectedMarkupIds.length > 0) {
      for (const id of selectedMarkupIds) {
        const markup = markups.find(m => m.id === id);
        if (markup) {
          const handle = getResizeHandle(point, markup);
          if (handle) {
            setHoveredHandle(handle);
            return;
          }
        }
      }
    }
    setHoveredHandle(null);
  };

  // Complete polygon/polyline/cloud drawing
  const completePolygonDrawing = useCallback(() => {
    if (!drawing.isDrawing || drawing.currentPoints.length < 2) {
      finishDrawing();
      return;
    }

    // Remove the preview point (last point) and use confirmed points
    const confirmedPoints = drawing.currentPoints.slice(0, -1);
    
    // Need at least 2 points for polyline, 3 for polygon/cloud
    const minPoints = activeTool === 'polyline' ? 2 : 3;
    if (confirmedPoints.length < minPoints) {
      finishDrawing();
      return;
    }
    
    const startPoint = confirmedPoints[0];
    const endPoint = confirmedPoints[confirmedPoints.length - 1];

    const newMarkup = createMarkup(activeTool, startPoint, endPoint, confirmedPoints, defaultStyle, measureScale, measureUnit);

    if (newMarkup) {
      addMarkup(currentPage, newMarkup);
    }

    finishDrawing();
  }, [drawing, activeTool, defaultStyle, measureScale, measureUnit, currentPage, addMarkup, finishDrawing]);

  const handleMouseUp = async (e: MouseEvent<HTMLCanvasElement>) => {
    if (areaDrag) {
      const end = getMousePosition(e);
      setAreaDrag(null);
      const geometry = pickGeometry(currentPage);
      const identity = { ...geometry, renderScale: 1 };
      const size = getRenderPageSize(identity);
      const clamp = (v: number) => Math.max(0, Math.min(100, v));
      const a = docToRender(areaDrag.start, identity);
      const b = docToRender(end, identity);
      const x1 = clamp((Math.min(a.x, b.x) / size.width) * 100);
      const y1 = clamp((Math.min(a.y, b.y) / size.height) * 100);
      const x2 = clamp((Math.max(a.x, b.x) / size.width) * 100);
      const y2 = clamp((Math.max(a.y, b.y) / size.height) * 100);
      const r1 = (v: number) => Math.round(v * 10) / 10;
      if (x2 - x1 >= 0.3 && y2 - y1 >= 0.3) {
        useDrawingPickStore.getState().addArea({
          documentId: activeDocId || undefined,
          page: currentPage,
          xPct: r1(x1),
          yPct: r1(y1),
          wPct: r1(x2 - x1),
          hPct: r1(y2 - y1),
        });
      }
      return;
    }
    // End resizing
    if (resizing) {
      const editedId = resizing.originalMarkup.id;
      setResizing(null);
      endEditorInteraction();
      refreshRunMarkup(editedId);
      return;
    }
    
    if (isDragging) {
      setIsDragging(false);
      endEditorInteraction();
      setDragStart(null);
      // Suggested runs tied to a moved fixture follow it.
      followMovedFixtures(selectedMarkupIds);
      return;
    }
    
    // Handle highlight text selection completion
    if (highlightSelection?.selectedWords && highlightSelection.selectedWords.length > 0) {
      // Create highlight markups per line
      const lineGroups = groupWordsByLine(highlightSelection.selectedWords);
      
      for (const lineWords of lineGroups) {
        const bounds = getWordsBoundingBox(lineWords);
        const padding = 2;
        
        const highlightMarkup: RectangleMarkup = {
          id: `highlight-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: 'highlight',
          page: currentPage,
          style: { ...defaultStyle, fillColor: 'rgba(253, 224, 71, 0.35)' },
          locked: false,
          author: 'Current User',
          createdAt: new Date().toISOString(),
          x: bounds.x - padding,
          y: bounds.y - padding,
          width: bounds.width + padding * 2,
          height: bounds.height + padding * 2,
        };
        
        addMarkup(currentPage, highlightMarkup);
      }
      
      setHighlightSelection(null);
      return;
    }
    
    // Skip completion for polyline/polygon/cloud - they complete on double-click or Enter
    if ((activeTool === 'polyline' || activeTool === 'polygon' || activeTool === 'cloud') && drawing.isDrawing) {
      return;
    }
    
    if (drawing.isDrawing && drawing.currentPoints.length >= 2) {
      const points = drawing.currentPoints;
      let startPoint = points[0];
      let endPoint = points[points.length - 1];
      
      // For highlight tool, try to snap to text
      if (activeTool === 'highlight') {
        const pdfDoc = getPdfDocument();
        if (pdfDoc) {
          // Get or extract text content
          let textItems = getTextContent(currentPage);
          if (textItems.length === 0) {
            try {
              textItems = await getTextContentWithBounds(pdfDoc, currentPage);
              setTextContent(currentPage, textItems);
            } catch (err) {
              console.warn('Could not extract text content:', err);
            }
          }
          
          if (textItems.length > 0) {
            // Find text in the drawn region
            const selectionBox = {
              x: Math.min(startPoint.x, endPoint.x),
              y: Math.min(startPoint.y, endPoint.y),
              width: Math.abs(endPoint.x - startPoint.x),
              height: Math.abs(endPoint.y - startPoint.y),
            };
            
            const intersectedText = findTextInRegion(textItems, selectionBox);
            if (intersectedText.length > 0) {
              const textBounds = getTextBoundingBox(intersectedText);
              if (textBounds) {
                // Snap to text bounds with padding
                const padding = 2;
                startPoint = { x: textBounds.x - padding, y: textBounds.y - padding };
                endPoint = { 
                  x: textBounds.x + textBounds.width + padding, 
                  y: textBounds.y + textBounds.height + padding 
                };
              }
            }
          }
        }
      }
      
      const newMarkup = createMarkup(activeTool, startPoint, endPoint, points, defaultStyle, measureScale, measureUnit);
      
      if (newMarkup) {
        if (
          activeProductId &&
          (newMarkup.type === 'measurement-length' || newMarkup.type === 'measurement-area')
        ) {
          (newMarkup as any).productId = activeProductId;
        }

        addMarkup(currentPage, newMarkup);
        
        // Auto-link measurement to active product
        if (activeProductId && (newMarkup.type === 'measurement-length' || newMarkup.type === 'measurement-area')) {
          const measurementType = newMarkup.type === 'measurement-length' ? 'length' : 'area';
          linkMeasurement(activeProductId, {
            markupId: newMarkup.id,
            documentId: activeDocId || 'unknown',
            page: currentPage,
            type: measurementType,
            value: (newMarkup as any).scaledValue || 0,
            unit: (newMarkup as any).unit || measureUnit,
          });
        }
        
        // If text was created, immediately enter edit mode
        if (newMarkup.type === 'text' || newMarkup.type === 'callout') {
          setTimeout(() => setEditingTextMarkup(newMarkup as TextMarkup), 50);
        }
      }
      
      finishDrawing();
    }
  };

  const createMarkup = (
    tool: string,
    startPoint: Point,
    endPoint: Point,
    points: Point[],
    style: typeof defaultStyle,
    scale: number,
    unit: string
  ): CanvasMarkup | null => {
    const id = `markup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const baseMarkup = {
      id,
      page: currentPage,
      style: { ...style },
      locked: false,
      author: 'Current User',
      createdAt: new Date().toISOString(),
    };
    
    switch (tool) {
      case 'rectangle':
      case 'highlight':
        return {
          ...baseMarkup,
          type: tool as 'rectangle' | 'highlight',
          x: Math.min(startPoint.x, endPoint.x),
          y: Math.min(startPoint.y, endPoint.y),
          width: Math.abs(endPoint.x - startPoint.x),
          height: Math.abs(endPoint.y - startPoint.y),
        };
        
      case 'ellipse':
        return {
          ...baseMarkup,
          type: 'ellipse',
          x: Math.min(startPoint.x, endPoint.x),
          y: Math.min(startPoint.y, endPoint.y),
          width: Math.abs(endPoint.x - startPoint.x),
          height: Math.abs(endPoint.y - startPoint.y),
        };
        
      case 'line':
      case 'arrow':
        return {
          ...baseMarkup,
          type: tool as 'line' | 'arrow',
          startX: startPoint.x,
          startY: startPoint.y,
          endX: endPoint.x,
          endY: endPoint.y,
        };
        
      case 'freehand':
      case 'polyline':
        return {
          ...baseMarkup,
          type: tool as 'freehand' | 'polyline',
          points: [...points],
        };
        
      case 'cloud':
      case 'polygon':
        // Use actual drawn points for polygon/cloud
        if (points.length < 3) return null;
        return {
          ...baseMarkup,
          type: tool as 'cloud' | 'polygon',
          points: [...points],
        };
        
      case 'text':
      case 'callout':
        return {
          ...baseMarkup,
          type: tool as 'text' | 'callout',
          x: Math.min(startPoint.x, endPoint.x),
          y: Math.min(startPoint.y, endPoint.y),
          width: Math.max(Math.abs(endPoint.x - startPoint.x), 100),
          height: Math.max(Math.abs(endPoint.y - startPoint.y), 30),
          content: '',
          leaderPoints: tool === 'callout' ? [
            { x: startPoint.x - 20, y: startPoint.y - 20 },
            startPoint,
          ] : undefined,
        };
        
      case 'measure-length': {
        const cal = useCanvasStore.getState().getPageCalibration(currentPage);
        const fromCal = computeLengthMeasurement(startPoint, endPoint, {
          renderPixelsPerUnit: pageCalibrationToRenderPixelsPerUnit(cal),
          unit: cal.unit,
        });
        return {
          ...baseMarkup,
          type: 'measurement-length',
          points: [startPoint, endPoint],
          value: fromCal.value,
          scaledValue: fromCal.scaledValue,
          unit: fromCal.unit,
          calibrated: fromCal.calibrated,
          aiNote: fromCal.note,
        };
      }
      
      case 'measure-area': {
        const minX = Math.min(startPoint.x, endPoint.x);
        const minY = Math.min(startPoint.y, endPoint.y);
        const maxX = Math.max(startPoint.x, endPoint.x);
        const maxY = Math.max(startPoint.y, endPoint.y);
        const areaPoints = [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ];
        const cal = useCanvasStore.getState().getPageCalibration(currentPage);
        const fromCal = computeAreaMeasurementFromPoints(areaPoints, {
          renderPixelsPerUnit: pageCalibrationToRenderPixelsPerUnit(cal),
          unit: cal.unit,
        });
        return {
          ...baseMarkup,
          type: 'measurement-area',
          points: areaPoints,
          value: fromCal.value,
          scaledValue: fromCal.scaledValue,
          unit: fromCal.unit,
          calibrated: fromCal.calibrated,
          aiNote: fromCal.note,
        };
      }
        
      default:
        return null;
    }
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Complete polygon/polyline/cloud on Enter
    if (e.key === 'Enter' && drawing.isDrawing && 
        (activeTool === 'polyline' || activeTool === 'polygon' || activeTool === 'cloud')) {
      completePolygonDrawing();
      return;
    }
    
    if (e.key === 'Escape') {
      if (editingTextMarkup) {
        setEditingTextMarkup(null);
        return;
      }
      
      // Track if we're canceling an in-progress action
      const wasInProgress = calibration.isCalibrating || drawing.isDrawing;
      
      if (calibration.isCalibrating) {
        cancelCalibration();
      }
      if (drawing.isDrawing) {
        cancelDrawing();
      }
      clearSelection();
      
      // If nothing was in progress (user was idle), revert to select tool
      if (!wasInProgress) {
        useEditorStore.getState().setActiveTool('select');
      }
    }
    
    if (e.key === 'Delete' && selectedMarkupIds.length > 0) {
      useCanvasStore.getState().deleteMarkups(currentPage, selectedMarkupIds);
    }
  }, [calibration.isCalibrating, drawing.isDrawing, selectedMarkupIds, currentPage, editingTextMarkup, activeTool, completePolygonDrawing]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Custom highlighter cursor SVG (yellow marker pen)
  const highlighterCursor = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='%23FCD34D' stroke='%23333' stroke-width='0.5' d='M18.5 1.5l4 4-12 12H7v-3.5l11.5-12.5z'/%3E%3Cpath fill='%23F59E0B' d='M7 17.5V21h3.5L7 17.5z'/%3E%3Cpath fill='none' stroke='%23333' stroke-width='0.5' d='M18.5 1.5l4 4'/%3E%3C/svg%3E") 2 22, text`;

  // Determine cursor based on active tool and hover state
  const getCursor = () => {
    if (isPicking) return 'crosshair';
    // If actively resizing, show resize cursor
    if (resizing) {
      return getResizeCursor(resizing.handle);
    }
    
    // Check for resize handle hover when in select mode
    if (activeTool === 'select' && hoveredHandle) {
      return getResizeCursor(hoveredHandle);
    }
    
    switch (activeTool) {
      case 'select': return hoveredMarkupId ? 'move' : 'default';
      case 'pan': return 'grab';
      case 'text': return 'text';
      case 'eraser': return eraserHoveredId ? 'pointer' : 'crosshair';
      case 'stamp': return 'copy';
      case 'count': return 'cell';
      case 'highlight': return isOverText ? 'text' : highlighterCursor;
      default: return 'crosshair';
    }
  };

  // Disable pointer events on markup canvas when pan tool is active

  return (
    <>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="absolute top-0 left-0"
        style={{ 
          cursor: getCursor(),
          pointerEvents: isPanMode ? 'none' : 'auto',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
        onMouseLeave={() => {
          setHoveredMarkup(null);
          setEraserHoveredId(null);
        }}
      />

      {isPicking && pickRequest && createPortal(
        <div className="pointer-events-none fixed left-1/2 top-16 z-[9999] -translate-x-1/2">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-violet-500/50 bg-popover/95 px-4 py-2 text-sm shadow-xl backdrop-blur">
            <span className="h-2 w-2 animate-pulse rounded-full bg-violet-500" />
            <span className="text-foreground">{pickRequest.label}</span>
            {pickRequest.mode === 'area' ? (
              <>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {(pickAreas[pickRequest.key] || []).length} marked · drag another box
                </span>
                <button
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent"
                  onClick={() => useDrawingPickStore.getState().cancel()}
                >
                  Done
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">Esc to cancel</span>
                <button
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => useDrawingPickStore.getState().cancel()}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {highlight && createPortal(
        <div className="pointer-events-none fixed left-1/2 top-28 z-[9998] -translate-x-1/2">
          <div className="pointer-events-auto flex max-w-[640px] flex-wrap items-center gap-2 rounded-full border border-yellow-400/50 bg-popover/95 px-4 py-1.5 text-xs shadow-xl backdrop-blur">
            <span className="h-2 w-2 rounded-full bg-yellow-400" />
            <span className="font-medium text-foreground">{highlight.name}</span>
            <span className="text-muted-foreground">
              {(highlight.byPage[currentPage] || []).length} on this page · {highlight.total} total
            </span>
            {Object.keys(highlight.byPage)
              .map(Number)
              .filter(page => page !== currentPage)
              .sort((a, b) => a - b)
              .slice(0, 8)
              .map(page => (
                <button
                  key={page}
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-yellow-400/60 hover:text-foreground"
                  onClick={() => useCanvasStore.getState().setCurrentPage(page)}
                >
                  p.{page} · {highlight.byPage[page].length}
                </button>
              ))}
            {highlight.otherDocuments > 0 && (
              <span className="text-muted-foreground">+{highlight.otherDocuments} in other documents</span>
            )}
            <button
              type="button"
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => useProductStore.getState().setSelectedNode(null)}
            >
              Clear
            </button>
          </div>
        </div>,
        document.body
      )}

      {countMenu && createPortal(
        <div
          className="fixed z-[9999] bg-popover border border-panel-border rounded shadow-xl text-sm"
          style={{ left: countMenu.x, top: countMenu.y }}
        >
          <button
            className="block w-full text-left px-3 py-2 hover:bg-accent"
            onClick={handleSplitCount}
          >
            Split count
          </button>
          <button
            className="block w-full text-left px-3 py-2 hover:bg-accent"
            onClick={handleResumeCount}
          >
            Resume count
          </button>
          <button
            className="block w-full text-left px-3 py-2 hover:bg-accent text-destructive"
            onClick={handleDeleteCount}
          >
            Delete count
          </button>
        </div>,
        document.body
      )}
      
      {/* Text edit overlay */}
      {editingTextMarkup && (
        <TextEditOverlay
          markup={editingTextMarkup}
          page={currentPage}
          onClose={() => setEditingTextMarkup(null)}
          canvasOffset={{ x: 0, y: 0 }}
          zoom={zoom}
        />
      )}
    </>
  );
}
