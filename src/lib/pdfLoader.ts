import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { capRenderScale, cssPageSize } from './renderScaleCap';

// Configure PDF.js worker for desktop app (no CDN dependency)
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const renderTasks = new WeakMap<HTMLCanvasElement, pdfjsLib.RenderTask>();
const renderSeq = new WeakMap<HTMLCanvasElement, number>();

export function cancelCanvasRender(canvas: HTMLCanvasElement): void {
  renderTasks.get(canvas)?.cancel();
  renderSeq.set(canvas, (renderSeq.get(canvas) ?? 0) + 1);
}

export function createPdfRangeTransport(
  url: string,
  size: number,
): pdfjsLib.PDFDataRangeTransport {
  class FileRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } })
        .then(r => r.arrayBuffer())
        .then(b => this.onDataRange(begin, new Uint8Array(b)))
        .catch(() => this.onDataRange(begin, new Uint8Array(0)));
    }
  }
  return new FileRangeTransport(size, new Uint8Array(0));
}

export function isRenderingCancelled(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'RenderingCancelledException';
}

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

export async function loadPDF(
  source: string | ArrayBuffer,
  options?: { copy?: boolean },
): Promise<LoadedPDF> {
  let documentSource: string | ArrayBuffer | Uint8Array = source;

  if (source instanceof ArrayBuffer) {
    documentSource = options?.copy === false ? new Uint8Array(source) : new Uint8Array(source.slice(0));
  }

  const loadingTask = pdfjsLib.getDocument(documentSource);
  const document = await loadingTask.promise;

  return {
    document,
    numPages: document.numPages,
  };
}

export async function loadPDFFromUrl(
  url: string,
  options?: { rangeChunkSize?: number },
): Promise<LoadedPDF> {
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (head.status !== 206) throw new Error(`PDF open failed (${head.status})`);
  const contentRange = head.headers.get('Content-Range');
  const size = Number(contentRange?.split('/')[1]);
  if (!Number.isFinite(size) || size <= 0) throw new Error('PDF open failed (missing size)');
  const loadingTask = pdfjsLib.getDocument({
    range: createPdfRangeTransport(url, size),
    rangeChunkSize: options?.rangeChunkSize ?? (1 << 20),
    disableAutoFetch: true,
    disableStream: true,
  });
  const document = await loadingTask.promise;
  return {
    document,
    numPages: document.numPages,
  };
}

export async function getPageLabels(document: pdfjsLib.PDFDocumentProxy): Promise<string[] | null> {
  try {
    const labels = await document.getPageLabels();
    return Array.isArray(labels) ? labels : null;
  } catch {
    return null;
  }
}

export async function renderPage(
  document: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number = 1.5
): Promise<PDFPageInfo> {
  const previous = renderTasks.get(canvas);
  previous?.cancel();
  const seq = (renderSeq.get(canvas) ?? 0) + 1;
  renderSeq.set(canvas, seq);

  const page = await document.getPage(pageNumber);
  if (renderSeq.get(canvas) !== seq) {
    throw Object.assign(new Error('superseded'), { name: 'RenderingCancelledException' });
  }
  renderTasks.get(canvas)?.cancel();
  const devicePixelRatio = window.devicePixelRatio || 1;
  const outputScale = devicePixelRatio * 2;
  const originalViewport = page.getViewport({ scale: 1 });
  const css = cssPageSize(scale, originalViewport.width, originalViewport.height);
  const backingScale = capRenderScale(scale * outputScale, originalViewport.width, originalViewport.height);
  const viewport = page.getViewport({ scale: backingScale });

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get canvas context');

  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${css.width}px`;
  canvas.style.height = `${css.height}px`;

  const task = page.render({
    canvasContext: context,
    viewport,
  });
  renderTasks.set(canvas, task);
  try {
    await task.promise;
  } finally {
    if (renderTasks.get(canvas) === task) renderTasks.delete(canvas);
    page.cleanup();
  }

  return {
    pageNumber,
    width: css.width,
    height: css.height,
    originalWidth: originalViewport.width,
    originalHeight: originalViewport.height,
  };
}

export async function prefetchPageOperators(
  document: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
): Promise<void> {
  if (pageNumber < 1 || pageNumber > document.numPages) return;
  const page = await document.getPage(pageNumber);
  try {
    await Promise.all([
      page.getOperatorList(),
      page.getTextContent(),
    ]);
  } finally {
    page.cleanup();
  }
}

export async function getPageDimensions(
  document: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
): Promise<{ width: number; height: number; rotationDeg: 0 | 90 | 180 | 270 }> {
  const page = await document.getPage(pageNumber);
  // pdfjs page.rotate is clockwise degrees; normalize to PageGeometry contract.
  const rawRotate = Number(page.rotate) || 0;
  const normalized = ((Math.round(rawRotate) % 360) + 360) % 360;
  const rotationDeg: 0 | 90 | 180 | 270 =
    normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;

  // Display viewport (includes page.rotate) — existing UI callers use these as canvas size.
  // loadPageGeometries converts to unrotated docWidth/docHeight for PageGeometry.
  const viewport = page.getViewport({ scale: 1 });
  return {
    width: viewport.width,
    height: viewport.height,
    rotationDeg,
  };
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

/**
 * Same y-grouping as groupTextIntoLines, then split a line into columns when
 * neighboring items have a large x-gap (schedule column vs plan text).
 */
export function groupTextIntoColumnLines(
  items: TextItemWithBounds[],
  yTolerance: number = 5,
  gapFactor: number = 2.5,
  minGap: number = 144,
): string[] {
  const lines = groupTextIntoLines(items, yTolerance);
  const texts: string[] = [];
  for (const line of lines) {
    const sorted = [...line.items].sort((a, b) => a.x - b.x);
    if (sorted.length <= 1) {
      const text = sorted.map(item => item.str).join(' ').trim();
      if (text) texts.push(text);
      continue;
    }
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      gaps.push(sorted[i].x - (prev.x + prev.width));
    }
    const medianGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
    const splitAt = Math.max(minGap, medianGap * gapFactor);
    let current: TextItemWithBounds[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      if (gaps[i - 1] > splitAt) {
        const text = current.map(item => item.str).join(' ').trim();
        if (text) texts.push(text);
        current = [sorted[i]];
      } else {
        current.push(sorted[i]);
      }
    }
    const text = current.map(item => item.str).join(' ').trim();
    if (text) texts.push(text);
  }
  return texts;
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
