import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configure PDF.js worker for desktop app (no CDN dependency)
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface PDFPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface LoadedPDF {
  document: pdfjsLib.PDFDocumentProxy;
  numPages: number;
}

export async function loadPDF(source: string | ArrayBuffer): Promise<LoadedPDF> {
  // When source is an ArrayBuffer, create a copy to prevent PDF.js from detaching the original
  // PDF.js often transfers ArrayBuffers to a worker, which detaches them (byteLength becomes 0)
  let documentSource: string | ArrayBuffer = source;
  
  if (source instanceof ArrayBuffer) {
    // Create a true copy with a new backing buffer
    const copiedBytes = new Uint8Array(source).slice();
    documentSource = copiedBytes.buffer;
  }
  
  const loadingTask = pdfjsLib.getDocument(documentSource);
  const document = await loadingTask.promise;
  
  return {
    document,
    numPages: document.numPages,
  };
}

export async function renderPage(
  document: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number = 1.5
): Promise<PDFPageInfo> {
  const page = await document.getPage(pageNumber);
  
  // Use device pixel ratio for crisp rendering on high-DPI displays
  const devicePixelRatio = window.devicePixelRatio || 1;
  const outputScale = devicePixelRatio * 2; // 2x for extra sharpness
  
  const viewport = page.getViewport({ scale: scale * outputScale });
  
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get canvas context');
  
  // Set canvas size to match high-DPI rendering
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  // Scale CSS size to match logical size
  canvas.style.width = `${viewport.width / outputScale}px`;
  canvas.style.height = `${viewport.height / outputScale}px`;
  
  const renderContext = {
    canvasContext: context,
    viewport: viewport,
  };
  
  await page.render(renderContext).promise;
  
  const originalViewport = page.getViewport({ scale: 1 });
  
  return {
    pageNumber,
    width: viewport.width / outputScale,
    height: viewport.height / outputScale,
    originalWidth: originalViewport.width,
    originalHeight: originalViewport.height,
  };
}

export async function getPageDimensions(
  document: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
): Promise<{ width: number; height: number }> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}

export async function getPageThumbnail(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  maxWidth: number = 150
): Promise<string> {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const scale = maxWidth / viewport.width;
  
  // Use 2x scale for crisp thumbnails
  const devicePixelRatio = window.devicePixelRatio || 1;
  const outputScale = devicePixelRatio * 2;
  const scaledViewport = page.getViewport({ scale: scale * outputScale });
  
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get canvas context');
  
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  canvas.style.width = `${scaledViewport.width / outputScale}px`;
  canvas.style.height = `${scaledViewport.height / outputScale}px`;
  
  await page.render({
    canvasContext: context,
    viewport: scaledViewport,
  }).promise;
  
  return canvas.toDataURL();
}

// Text extraction for highlight snapping
export interface TextItemWithBounds {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Text line grouping for highlight snapping
export interface TextLine {
  items: TextItemWithBounds[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function getTextContentWithBounds(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  renderScale: number = 1.5
): Promise<TextItemWithBounds[]> {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: renderScale });
  const textContent = await page.getTextContent();
  
  const textItems: TextItemWithBounds[] = [];
  
  for (const item of textContent.items) {
    if ('str' in item && item.str.trim()) {
      // Transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const transform = item.transform;
      const itemHeight = item.height || 12;
      const x = transform[4] * renderScale;
      const y = viewport.height - (transform[5] * renderScale) - (itemHeight * renderScale);
      const width = item.width * renderScale;
      const height = itemHeight * renderScale;
      
      textItems.push({
        str: item.str,
        x,
        y,
        width,
        height,
      });
    }
  }
  
  return textItems;
}

// Group text items into logical lines by Y-position proximity
export function groupTextIntoLines(
  items: TextItemWithBounds[],
  yTolerance: number = 5
): TextLine[] {
  if (items.length === 0) return [];
  
  // Sort by Y position, then by X
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  
  const lines: TextLine[] = [];
  let currentLineItems: TextItemWithBounds[] = [];
  let currentY = sorted[0].y;
  
  for (const item of sorted) {
    if (Math.abs(item.y - currentY) > yTolerance && currentLineItems.length > 0) {
      // Start new line
      lines.push(createLineFromItems(currentLineItems));
      currentLineItems = [];
    }
    currentLineItems.push(item);
    currentY = item.y;
  }
  
  if (currentLineItems.length > 0) {
    lines.push(createLineFromItems(currentLineItems));
  }
  
  return lines;
}

function createLineFromItems(items: TextItemWithBounds[]): TextLine {
  const minX = Math.min(...items.map(i => i.x));
  const minY = Math.min(...items.map(i => i.y));
  const maxX = Math.max(...items.map(i => i.x + i.width));
  const maxY = Math.max(...items.map(i => i.y + i.height));
  
  return {
    items,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// Extract text from all pages with progress callback
export async function extractTextForAllPages(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  renderScale: number = 1.5,
  onProgress?: (page: number, total: number) => void
): Promise<Record<number, TextItemWithBounds[]>> {
  const result: Record<number, TextItemWithBounds[]> = {};
  const totalPages = pdfDoc.numPages;
  
  for (let page = 1; page <= totalPages; page++) {
    result[page] = await getTextContentWithBounds(pdfDoc, page, renderScale);
    onProgress?.(page, totalPages);
  }
  
  return result;
}

// Extract text from specific pages with progress callback
export async function extractTextForPages(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pages: number[],
  renderScale: number = 1.5,
  onProgress?: (page: number, total: number) => void
): Promise<Record<number, TextItemWithBounds[]>> {
  const result: Record<number, TextItemWithBounds[]> = {};
  const totalPages = pages.length;
  
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page >= 1 && page <= pdfDoc.numPages) {
      result[page] = await getTextContentWithBounds(pdfDoc, page, renderScale);
    }
    onProgress?.(i + 1, totalPages);
  }
  
  return result;
}

// Render a PDF page at high DPI for OCR processing
export async function renderPageForOcr(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  dpi: number = 300
): Promise<HTMLCanvasElement> {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: dpi / 72 }); // 72 DPI is PDF default
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;
  
  return canvas;
}

// Word-level text extraction for professional highlight tool
export interface TextWord {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lineY: number; // Y-position for line grouping
  index: number; // Original index for ordering
}

// Convert text items to individual words with bounds
export function getWordsFromTextItems(items: TextItemWithBounds[]): TextWord[] {
  const words: TextWord[] = [];
  let wordIndex = 0;
  
  // Group items by line first
  const lines = groupTextIntoLines(items);
  
  for (const line of lines) {
    // Sort items in line by X position
    const sortedItems = [...line.items].sort((a, b) => a.x - b.x);
    
    for (const item of sortedItems) {
      // Split multi-word items
      const itemWords = item.str.split(/\s+/).filter(w => w.length > 0);
      
      if (itemWords.length === 0) continue;
      
      // Estimate character width
      const charWidth = item.width / item.str.length;
      let currentX = item.x;
      let charOffset = 0;
      
      for (const wordStr of itemWords) {
        // Find position of this word in the original string
        const wordStart = item.str.indexOf(wordStr, charOffset);
        const wordEndOffset = wordStart + wordStr.length;
        
        const wordX = item.x + (wordStart * charWidth);
        const wordWidth = wordStr.length * charWidth;
        
        words.push({
          str: wordStr,
          x: wordX,
          y: item.y,
          width: wordWidth,
          height: item.height,
          lineY: line.y,
          index: wordIndex++,
        });
        
        charOffset = wordEndOffset;
      }
    }
  }
  
  return words;
}

// Find word at a specific point
export function findWordAtPoint(words: TextWord[], point: { x: number; y: number }): TextWord | null {
  // Add some padding for easier selection
  const padding = 2;
  
  for (const word of words) {
    if (
      point.x >= word.x - padding &&
      point.x <= word.x + word.width + padding &&
      point.y >= word.y - padding &&
      point.y <= word.y + word.height + padding
    ) {
      return word;
    }
  }
  
  return null;
}

// Find all words between two words (for selection)
export function findWordsInRange(
  words: TextWord[],
  startWord: TextWord,
  endWord: TextWord
): TextWord[] {
  const startIndex = Math.min(startWord.index, endWord.index);
  const endIndex = Math.max(startWord.index, endWord.index);
  
  return words.filter(w => w.index >= startIndex && w.index <= endIndex);
}

// Group words by line for multi-line highlighting
export function groupWordsByLine(words: TextWord[]): TextWord[][] {
  if (words.length === 0) return [];
  
  const lineMap = new Map<number, TextWord[]>();
  const yTolerance = 5;
  
  for (const word of words) {
    // Find existing line with similar Y
    let foundLineY: number | null = null;
    for (const lineY of lineMap.keys()) {
      if (Math.abs(word.lineY - lineY) <= yTolerance) {
        foundLineY = lineY;
        break;
      }
    }
    
    if (foundLineY !== null) {
      lineMap.get(foundLineY)!.push(word);
    } else {
      lineMap.set(word.lineY, [word]);
    }
  }
  
  // Sort lines by Y position and words within each line by X position
  const sortedLines = Array.from(lineMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, words]) => words.sort((a, b) => a.x - b.x));
  
  return sortedLines;
}

// Get bounding box for a group of words
export function getWordsBoundingBox(words: TextWord[]): { x: number; y: number; width: number; height: number } {
  if (words.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  
  const minX = Math.min(...words.map(w => w.x));
  const minY = Math.min(...words.map(w => w.y));
  const maxX = Math.max(...words.map(w => w.x + w.width));
  const maxY = Math.max(...words.map(w => w.y + w.height));
  
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
