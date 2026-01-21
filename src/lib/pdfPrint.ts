import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { CanvasMarkup } from '@/types/markup';
import { renderPage } from './pdfLoader';

export interface PrintOptions {
  pageRange?: { start: number; end: number };
  includeMarkups?: boolean;
}

// Draw markups on a canvas context
function drawMarkupsOnCanvas(
  ctx: CanvasRenderingContext2D,
  markups: CanvasMarkup[],
  scale: number
): void {
  for (const markup of markups) {
    const opacity = (markup.style.opacity ?? 100) / 100;
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = markup.style.strokeColor;
    ctx.fillStyle = markup.style.fillColor === 'transparent' ? 'transparent' : markup.style.fillColor;
    ctx.lineWidth = markup.style.strokeWidth * scale;
    ctx.font = `${(markup.style.fontSize || 12) * scale}px ${markup.style.fontFamily || 'Arial'}`;

    switch (markup.type) {
      case 'rectangle':
      case 'highlight': {
        const m = markup as any;
        if (markup.type === 'highlight') {
          ctx.fillStyle = 'rgba(255, 255, 0, 0.3)';
          ctx.fillRect(m.x * scale, m.y * scale, m.width * scale, m.height * scale);
        } else {
          if (m.style.fillColor !== 'transparent') {
            ctx.fillRect(m.x * scale, m.y * scale, m.width * scale, m.height * scale);
          }
          ctx.strokeRect(m.x * scale, m.y * scale, m.width * scale, m.height * scale);
        }
        break;
      }

      case 'ellipse': {
        const m = markup as any;
        const centerX = (m.x + m.width / 2) * scale;
        const centerY = (m.y + m.height / 2) * scale;
        const radiusX = (m.width / 2) * scale;
        const radiusY = (m.height / 2) * scale;
        
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
        if (m.style.fillColor !== 'transparent') {
          ctx.fill();
        }
        ctx.stroke();
        break;
      }

      case 'line':
      case 'arrow': {
        const m = markup as any;
        ctx.beginPath();
        ctx.moveTo(m.startX * scale, m.startY * scale);
        ctx.lineTo(m.endX * scale, m.endY * scale);
        ctx.stroke();
        
        if (markup.type === 'arrow') {
          const angle = Math.atan2(
            (m.endY - m.startY) * scale,
            (m.endX - m.startX) * scale
          );
          const arrowLength = 15 * scale;
          const arrowAngle = Math.PI / 6;
          
          ctx.beginPath();
          ctx.moveTo(m.endX * scale, m.endY * scale);
          ctx.lineTo(
            m.endX * scale - arrowLength * Math.cos(angle - arrowAngle),
            m.endY * scale - arrowLength * Math.sin(angle - arrowAngle)
          );
          ctx.moveTo(m.endX * scale, m.endY * scale);
          ctx.lineTo(
            m.endX * scale - arrowLength * Math.cos(angle + arrowAngle),
            m.endY * scale - arrowLength * Math.sin(angle + arrowAngle)
          );
          ctx.stroke();
        }
        break;
      }

      case 'polygon':
      case 'polyline':
      case 'freehand':
      case 'cloud': {
        const m = markup as any;
        if (m.points.length < 2) break;
        
        ctx.beginPath();
        ctx.moveTo(m.points[0].x * scale, m.points[0].y * scale);
        for (let i = 1; i < m.points.length; i++) {
          ctx.lineTo(m.points[i].x * scale, m.points[i].y * scale);
        }
        if (markup.type === 'polygon' || markup.type === 'cloud') {
          ctx.closePath();
        }
        if (m.style.fillColor !== 'transparent' && (markup.type === 'polygon' || markup.type === 'cloud')) {
          ctx.fill();
        }
        ctx.stroke();
        break;
      }

      case 'text':
      case 'callout': {
        const m = markup as any;
        ctx.fillStyle = markup.style.strokeColor;
        ctx.fillText(m.content || '', m.x * scale, (m.y + (markup.style.fontSize || 12)) * scale);
        break;
      }

      case 'stamp': {
        const m = markup as any;
        const STAMP_TEXT: Record<string, string> = {
          approved: 'APPROVED',
          rejected: 'REJECTED',
          draft: 'DRAFT',
          reviewed: 'REVIEWED',
          confidential: 'CONFIDENTIAL',
          void: 'VOID',
        };
        const text = STAMP_TEXT[m.preset] || m.preset.toUpperCase();
        
        ctx.strokeStyle = markup.style.strokeColor;
        ctx.lineWidth = 2 * scale;
        ctx.strokeRect(m.x * scale - 5, m.y * scale - 5, text.length * 12 * scale + 10, 30 * scale);
        
        ctx.fillStyle = markup.style.strokeColor;
        ctx.font = `bold ${14 * scale}px Arial`;
        ctx.fillText(text, m.x * scale, (m.y + 20) * scale);
        break;
      }

      case 'count-marker': {
        const m = markup as any;
        const radius = 12 * scale;
        
        ctx.beginPath();
        ctx.arc(m.x * scale, m.y * scale, radius, 0, 2 * Math.PI);
        ctx.fillStyle = markup.style.strokeColor;
        ctx.fill();
        
        ctx.fillStyle = 'white';
        ctx.font = `bold ${10 * scale}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.number.toString(), m.x * scale, m.y * scale);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
        break;
      }

      case 'measurement-length':
      case 'measurement-area': {
        const m = markup as any;
        if (m.points.length < 2) break;
        
        ctx.beginPath();
        ctx.moveTo(m.points[0].x * scale, m.points[0].y * scale);
        for (let i = 1; i < m.points.length; i++) {
          ctx.lineTo(m.points[i].x * scale, m.points[i].y * scale);
        }
        ctx.stroke();
        
        const midPoint = m.points[Math.floor(m.points.length / 2)];
        const valueText = `${m.scaledValue.toFixed(2)} ${m.unit}`;
        ctx.fillStyle = markup.style.strokeColor;
        ctx.font = `${10 * scale}px Arial`;
        ctx.fillText(valueText, midPoint.x * scale, (midPoint.y - 10) * scale);
        break;
      }
    }
    
    ctx.globalAlpha = 1;
  }
}

export async function printDocument(
  pdfDocument: PDFDocumentProxy,
  markupsByPage: Record<number, CanvasMarkup[]>,
  options: PrintOptions = {}
): Promise<void> {
  const { pageRange, includeMarkups = true } = options;
  const numPages = pdfDocument.numPages;
  const startPage = pageRange?.start || 1;
  const endPage = pageRange?.end || numPages;
  
  // Create a hidden iframe for printing
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  document.body.appendChild(iframe);
  
  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) {
    document.body.removeChild(iframe);
    throw new Error('Could not access iframe document');
  }
  
  // Add print styles
  iframeDoc.open();
  iframeDoc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        @media print {
          @page {
            margin: 0;
            size: auto;
          }
          body {
            margin: 0;
            padding: 0;
          }
          .page {
            page-break-after: always;
            display: flex;
            justify-content: center;
            align-items: center;
            width: 100%;
          }
          .page:last-child {
            page-break-after: avoid;
          }
          img {
            max-width: 100%;
            height: auto;
          }
        }
        body {
          margin: 0;
          padding: 0;
        }
        .page {
          display: flex;
          justify-content: center;
          margin-bottom: 10px;
        }
      </style>
    </head>
    <body></body>
    </html>
  `);
  iframeDoc.close();
  
  const body = iframeDoc.body;
  const scale = 1.5; // Match the render scale from pdfLoader
  
  // Render each page
  for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
    const pageDiv = iframeDoc.createElement('div');
    pageDiv.className = 'page';
    
    // Create canvas for PDF page
    const canvas = iframeDoc.createElement('canvas');
    await renderPage(pdfDocument, pageNum, canvas as unknown as HTMLCanvasElement, scale);
    
    // Draw markups if enabled
    if (includeMarkups && markupsByPage[pageNum]) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        drawMarkupsOnCanvas(ctx, markupsByPage[pageNum], 1);
      }
    }
    
    // Convert canvas to image for better print quality
    const img = iframeDoc.createElement('img');
    img.src = canvas.toDataURL('image/png');
    pageDiv.appendChild(img);
    body.appendChild(pageDiv);
  }
  
  // Wait for images to load, then print
  await new Promise(resolve => setTimeout(resolve, 500));
  
  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();
  
  // Clean up after a delay
  setTimeout(() => {
    document.body.removeChild(iframe);
  }, 1000);
}
