import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { CanvasMarkup, RectangleMarkup, LineMarkup, PolygonMarkup, TextMarkup, StampMarkup, CountMarkerMarkup, MeasurementMarkup } from '@/types/markup';

// Convert hex color to RGB
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return {
      r: parseInt(result[1], 16) / 255,
      g: parseInt(result[2], 16) / 255,
      b: parseInt(result[3], 16) / 255,
    };
  }
  return { r: 0, g: 0, b: 0 };
}

// Stamp preset text mapping
const STAMP_TEXT: Record<string, string> = {
  approved: 'APPROVED',
  rejected: 'REJECTED',
  draft: 'DRAFT',
  reviewed: 'REVIEWED',
  confidential: 'CONFIDENTIAL',
  void: 'VOID',
};

/**
 * Export PDF with markups baked in.
 * 
 * Markups are stored in "PDF coordinate space" which is the coordinate system
 * at 100% zoom with the base render scale (1.5x). To convert to actual PDF coordinates,
 * we need to divide by the base render scale.
 * 
 * @param originalPdfBytes - The original PDF file bytes
 * @param markupsByPage - Markups organized by page number
 * @param baseRenderScale - The base render scale used (default 1.5)
 */
export async function exportPdfWithMarkups(
  originalPdfBytes: ArrayBuffer,
  markupsByPage: Record<number, CanvasMarkup[]>,
  baseRenderScale: number = 1.5 // The base render scale used in pdfLoader
): Promise<Uint8Array> {
  // Validate ArrayBuffer
  if (!originalPdfBytes || originalPdfBytes.byteLength === 0) {
    throw new Error('Invalid PDF bytes provided');
  }
  
  // Create Uint8Array from the buffer for pdf-lib (handles detached buffer cases)
  const pdfBytesArray = new Uint8Array(originalPdfBytes);
  const pdfDoc = await PDFDocument.load(pdfBytesArray);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const [pageNumStr, markups] of Object.entries(markupsByPage)) {
    const pageNum = parseInt(pageNumStr, 10);
    const pageIndex = pageNum - 1;
    
    if (pageIndex < 0 || pageIndex >= pages.length) continue;
    
    const page = pages[pageIndex];
    const { width: pageWidth, height: pageHeight } = page.getSize();
    
    // Scale factor to convert from our PDF coordinate space to actual PDF coordinates
    // Our coordinates are at baseRenderScale (1.5x), so we divide by that
    const scaleFactor = 1 / baseRenderScale;

    for (const markup of markups) {
      const opacity = (markup.style.opacity ?? 100) / 100;
      const strokeColor = hexToRgb(markup.style.strokeColor);
      const fillColor = markup.style.fillColor === 'transparent' 
        ? null 
        : hexToRgb(markup.style.fillColor);
      const strokeWidth = markup.style.strokeWidth * scaleFactor;

      switch (markup.type) {
        case 'rectangle':
        case 'highlight': {
          const m = markup as RectangleMarkup;
          const x = m.x * scaleFactor;
          const y = pageHeight - (m.y * scaleFactor) - (m.height * scaleFactor);
          const width = m.width * scaleFactor;
          const height = m.height * scaleFactor;
          
          if (markup.type === 'highlight') {
            page.drawRectangle({
              x, y, width, height,
              color: rgb(1, 1, 0), // Yellow highlight
              opacity: 0.3,
            });
          } else {
            page.drawRectangle({
              x, y, width, height,
              borderColor: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
              borderWidth: strokeWidth,
              color: fillColor ? rgb(fillColor.r, fillColor.g, fillColor.b) : undefined,
              opacity: fillColor ? opacity : undefined,
              borderOpacity: opacity,
            });
          }
          break;
        }

        case 'ellipse': {
          const m = markup as RectangleMarkup;
          const centerX = (m.x + m.width / 2) * scaleFactor;
          const centerY = pageHeight - (m.y + m.height / 2) * scaleFactor;
          const xScale = (m.width / 2) * scaleFactor;
          const yScale = (m.height / 2) * scaleFactor;
          
          page.drawEllipse({
            x: centerX,
            y: centerY,
            xScale,
            yScale,
            borderColor: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
            borderWidth: strokeWidth,
            color: fillColor ? rgb(fillColor.r, fillColor.g, fillColor.b) : undefined,
            opacity: fillColor ? opacity : undefined,
            borderOpacity: opacity,
          });
          break;
        }

        case 'line':
        case 'arrow': {
          const m = markup as LineMarkup;
          const startX = m.startX * scaleFactor;
          const startY = pageHeight - m.startY * scaleFactor;
          const endX = m.endX * scaleFactor;
          const endY = pageHeight - m.endY * scaleFactor;
          
          page.drawLine({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            thickness: strokeWidth,
            color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
            opacity,
          });
          
          // Draw arrowhead for arrow type
          if (markup.type === 'arrow') {
            const angle = Math.atan2(endY - startY, endX - startX);
            const arrowLength = 15 * scaleFactor;
            const arrowAngle = Math.PI / 6;
            
            const arrow1X = endX - arrowLength * Math.cos(angle - arrowAngle);
            const arrow1Y = endY - arrowLength * Math.sin(angle - arrowAngle);
            const arrow2X = endX - arrowLength * Math.cos(angle + arrowAngle);
            const arrow2Y = endY - arrowLength * Math.sin(angle + arrowAngle);
            
            page.drawLine({
              start: { x: endX, y: endY },
              end: { x: arrow1X, y: arrow1Y },
              thickness: strokeWidth,
              color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
              opacity,
            });
            page.drawLine({
              start: { x: endX, y: endY },
              end: { x: arrow2X, y: arrow2Y },
              thickness: strokeWidth,
              color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
              opacity,
            });
          }
          break;
        }

        case 'polygon':
        case 'polyline':
        case 'freehand':
        case 'cloud': {
          const m = markup as PolygonMarkup;
          if (m.points.length < 2) break;
          
          for (let i = 0; i < m.points.length - 1; i++) {
            const startX = m.points[i].x * scaleFactor;
            const startY = pageHeight - m.points[i].y * scaleFactor;
            const endX = m.points[i + 1].x * scaleFactor;
            const endY = pageHeight - m.points[i + 1].y * scaleFactor;
            
            page.drawLine({
              start: { x: startX, y: startY },
              end: { x: endX, y: endY },
              thickness: strokeWidth,
              color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
              opacity,
            });
          }
          
          // Close polygon
          if (markup.type === 'polygon' || markup.type === 'cloud') {
            const lastPoint = m.points[m.points.length - 1];
            const firstPoint = m.points[0];
            page.drawLine({
              start: { x: lastPoint.x * scaleFactor, y: pageHeight - lastPoint.y * scaleFactor },
              end: { x: firstPoint.x * scaleFactor, y: pageHeight - firstPoint.y * scaleFactor },
              thickness: strokeWidth,
              color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
              opacity,
            });
          }
          break;
        }

        case 'text':
        case 'callout': {
          const m = markup as TextMarkup;
          const x = m.x * scaleFactor;
          const y = pageHeight - m.y * scaleFactor - (m.style.fontSize || 12);
          const fontSize = (m.style.fontSize || 12) * scaleFactor;
          
          page.drawText(m.content || '', {
            x,
            y,
            size: fontSize,
            font,
            color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
            opacity,
          });
          break;
        }

        case 'stamp': {
          const m = markup as StampMarkup;
          const text = STAMP_TEXT[m.preset] || m.preset.toUpperCase();
          const x = m.x * scaleFactor;
          const y = pageHeight - m.y * scaleFactor - 20;
          
          // Draw stamp background
          page.drawRectangle({
            x: x - 5,
            y: y - 5,
            width: text.length * 12 * scaleFactor + 10,
            height: 30 * scaleFactor,
            borderColor: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
            borderWidth: 2 * scaleFactor,
            opacity,
          });
          
          page.drawText(text, {
            x,
            y,
            size: 14 * scaleFactor,
            font: boldFont,
            color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
            opacity,
          });
          break;
        }

        case 'count-marker': {
          const m = markup as CountMarkerMarkup;
          const x = m.x * scaleFactor;
          const y = pageHeight - m.y * scaleFactor;
          const radius = 12 * scaleFactor;
          
          page.drawCircle({
            x,
            y,
            size: radius,
            color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
            opacity,
          });
          
          page.drawText(m.number.toString(), {
            x: x - 4 * scaleFactor,
            y: y - 4 * scaleFactor,
            size: 10 * scaleFactor,
            font: boldFont,
            color: rgb(1, 1, 1),
          });
          break;
        }

        case 'measurement-length':
        case 'measurement-area': {
          const m = markup as MeasurementMarkup;
          if (m.points.length < 2) break;
          
          // Draw measurement lines
          for (let i = 0; i < m.points.length - 1; i++) {
            const startX = m.points[i].x * scaleFactor;
            const startY = pageHeight - m.points[i].y * scaleFactor;
            const endX = m.points[i + 1].x * scaleFactor;
            const endY = pageHeight - m.points[i + 1].y * scaleFactor;
            
            page.drawLine({
              start: { x: startX, y: startY },
              end: { x: endX, y: endY },
              thickness: strokeWidth,
              color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
              opacity,
            });
          }
          
          // Draw measurement value
          const midPoint = m.points[Math.floor(m.points.length / 2)];
          const valueText = `${m.scaledValue.toFixed(2)} ${m.unit}`;
          
          page.drawText(valueText, {
            x: midPoint.x * scaleFactor,
            y: pageHeight - midPoint.y * scaleFactor + 10,
            size: 10 * scaleFactor,
            font,
            color: rgb(strokeColor.r, strokeColor.g, strokeColor.b),
            opacity,
          });
          break;
        }
      }
    }
  }

  return pdfDoc.save();
}

export function downloadPdf(pdfBytes: Uint8Array, fileName: string): void {
  const blob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
