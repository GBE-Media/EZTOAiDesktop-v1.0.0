import { useRef, useEffect, useState, useCallback, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { ToolType } from '@/types/editor';
import { useProductStore } from '@/store/productStore';
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

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end';

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
    scale,
    scaleUnit,
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
    getTextContent,
    setTextContent,
    getTextWords,
    setTextWords,
    getPdfDocument,
    getOcrStatus,
    extractDocumentSnapData,
    setActiveSnapPoint,
  } = useCanvasStore();

  const { activeTool, selectedStamp, gridEnabled, rotation } = useEditorStore();
  const { activeProductId, linkMeasurement, activeCountGroupId, setActiveCountGroup, setActiveProduct } = useProductStore();
  
  // Get current document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const currentPage = currentDocData?.currentPage || 1;
  const markupsByPage = currentDocData?.markupsByPage || {};
  const markups = markupsByPage[currentPage] || [];
  const isPanMode = activeTool === 'pan';

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
    markups.forEach((markup) => {
      const isSelected = selectedMarkupIds.includes(markup.id);
      const isHovered = hoveredMarkupId === markup.id;
      const isEraserHovered = eraserHoveredId === markup.id;
      
      drawMarkup(ctx, markup, isSelected, isHovered, isEraserHovered);
    });
    
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
  }, [width, height, markups, selectedMarkupIds, hoveredMarkupId, eraserHoveredId, drawing, calibration, gridSize, snapToGrid, activeTool, defaultStyle, highlightSelection, zoom, activeSnapPoint, gridEnabled]);

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
    
    switch (markup.type) {
      case 'rectangle': {
        const m = markup as RectangleMarkup;
        if (m.style.fillColor !== 'transparent' || isEraserHovered) {
          ctx.fillRect(m.x, m.y, m.width, m.height);
        }
        ctx.strokeRect(m.x, m.y, m.width, m.height);
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
        ctx.stroke();
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
        ctx.fillStyle = isEraserHovered ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255, 255, 255, 0.9)';
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
        ctx.stroke();
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
        const scaledDist = dist / scale;
        
        ctx.setLineDash([]);
        ctx.fillStyle = '#22c55e';
        ctx.font = '11px monospace';
        ctx.fillText(
          `${scaledDist.toFixed(2)} ${scaleUnit}`,
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
        const scaledArea = areaPixels / (scale * scale);
        const areaUnit = scaleUnit === 'ft' ? 'sq ft' : `sq ${scaleUnit}`;
        
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
        return 'default';
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
        style: { ...defaultStyle },
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
            return;
          }
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
        setIsDragging(true);
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

    const newMarkup = createMarkup(activeTool, startPoint, endPoint, confirmedPoints, defaultStyle, scale, scaleUnit);

    if (newMarkup) {
      addMarkup(currentPage, newMarkup);
    }

    finishDrawing();
  }, [drawing, activeTool, defaultStyle, scale, scaleUnit, currentPage, addMarkup, finishDrawing]);

  const handleMouseUp = async (e: MouseEvent<HTMLCanvasElement>) => {
    // End resizing
    if (resizing) {
      setResizing(null);
      return;
    }
    
    if (isDragging) {
      setIsDragging(false);
      setDragStart(null);
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
      
      const newMarkup = createMarkup(activeTool, startPoint, endPoint, points, defaultStyle, scale, scaleUnit);
      
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
            unit: (newMarkup as any).unit || scaleUnit,
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
        const distance = Math.sqrt(
          Math.pow(endPoint.x - startPoint.x, 2) +
          Math.pow(endPoint.y - startPoint.y, 2)
        );
        return {
          ...baseMarkup,
          type: 'measurement-length',
          points: [startPoint, endPoint],
          value: distance,
          scaledValue: distance / scale,
          unit,
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
        const width = maxX - minX;
        const height = maxY - minY;
        const areaPixels = width * height;
        return {
          ...baseMarkup,
          type: 'measurement-area',
          points: areaPoints,
          value: areaPixels,
          scaledValue: areaPixels / (scale * scale),
          unit: unit === 'ft' ? 'sq ft' : `sq ${unit}`,
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
