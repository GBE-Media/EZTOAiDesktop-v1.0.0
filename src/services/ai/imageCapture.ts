/**
 * Image Capture Utilities for AI Analysis
 * Converts PDF pages to images for vision model processing
 */

import { renderPageForOcr } from '@/lib/pdfLoader';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface CapturedImage {
  base64: string;
  width: number;
  height: number;
  page: number;
  scale: number;
}

export interface PageTileRegion {
  id: string;
  row: number;
  col: number;
  /** Expanded crop bounds in PDF points. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Non-overlapping cell used to assign ownership during deduplication. */
  ownership: { x: number; y: number; width: number; height: number };
}

export interface CapturedPageTile extends CapturedImage {
  region: PageTileRegion;
}

export interface PageVisionBundle {
  page: number;
  pageWidth: number;
  pageHeight: number;
  overview: CapturedImage;
  tiles: CapturedPageTile[];
}

const DEFAULT_MAX_IMAGE_BYTES = 9 * 1024 * 1024;

function estimatedBase64Bytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',');
  const encodedLength = commaIndex >= 0 ? dataUrl.length - commaIndex - 1 : dataUrl.length;
  return (encodedLength * 3) / 4;
}

function resizeCanvas(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const resized = document.createElement('canvas');
  resized.width = Math.max(1, Math.round(source.width * scale));
  resized.height = Math.max(1, Math.round(source.height * scale));
  const context = resized.getContext('2d');
  if (!context) throw new Error('Failed to create resized AI image');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, resized.width, resized.height);
  return resized;
}

/**
 * Export losslessly where possible. If a PNG exceeds the transport budget,
 * reduce dimensions first; only use high-quality JPEG as the final fallback.
 */
function exportCanvasWithinLimit(
  source: HTMLCanvasElement,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES
): { base64: string; width: number; height: number } {
  let canvas = source;
  let result = canvas.toDataURL('image/png');

  for (let attempt = 0; estimatedBase64Bytes(result) > maxBytes && attempt < 3; attempt += 1) {
    const factor = Math.max(0.65, Math.sqrt(maxBytes / estimatedBase64Bytes(result)) * 0.95);
    canvas = resizeCanvas(canvas, factor);
    result = canvas.toDataURL('image/png');
  }

  if (estimatedBase64Bytes(result) > maxBytes) {
    result = canvas.toDataURL('image/jpeg', 0.94);
  }

  return { base64: result, width: canvas.width, height: canvas.height };
}

/**
 * Build overlapping tile crops in PDF-point coordinates. Ownership cells do
 * not overlap; expanded crop bounds provide context around boundary symbols.
 */
export function generateOverlappingTileRegions(
  pageWidth: number,
  pageHeight: number,
  rows: number = 3,
  cols: number = 3,
  overlapRatio: number = 0.12
): PageTileRegion[] {
  const cellWidth = pageWidth / cols;
  const cellHeight = pageHeight / rows;
  const overlapX = cellWidth * Math.max(0, overlapRatio);
  const overlapY = cellHeight * Math.max(0, overlapRatio);
  const regions: PageTileRegion[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const ownership = {
        x: col * cellWidth,
        y: row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      };
      const x = Math.max(0, ownership.x - overlapX);
      const y = Math.max(0, ownership.y - overlapY);
      const right = Math.min(pageWidth, ownership.x + ownership.width + overlapX);
      const bottom = Math.min(pageHeight, ownership.y + ownership.height + overlapY);

      regions.push({
        id: `r${row + 1}c${col + 1}`,
        row,
        col,
        x,
        y,
        width: right - x,
        height: bottom - y,
        ownership,
      });
    }
  }

  return regions;
}

/**
 * Capture a single PDF page as a base64 image
 */
export async function capturePageImage(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  options: {
    scale?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
  } = {}
): Promise<CapturedImage> {
  const { scale = 1.5, format = 'png', quality = 0.92 } = options;
  
  const dpi = Math.max(72, Math.round(scale * 72));
  const canvas = await renderPageForOcr(pdfDoc, pageNumber, dpi);
  
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const base64 = canvas.toDataURL(mimeType, quality);
  
  return {
    base64,
    width: canvas.width,
    height: canvas.height,
    page: pageNumber,
    scale,
  };
}

/**
 * Capture multiple PDF pages as base64 images
 */
export async function captureMultiplePages(
  pdfDoc: PDFDocumentProxy,
  pageNumbers: number[],
  options: {
    scale?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
    onProgress?: (current: number, total: number) => void;
  } = {}
): Promise<CapturedImage[]> {
  const { onProgress, ...captureOptions } = options;
  const results: CapturedImage[] = [];
  
  for (let i = 0; i < pageNumbers.length; i++) {
    const pageNumber = pageNumbers[i];
    onProgress?.(i + 1, pageNumbers.length);
    
    const image = await capturePageImage(pdfDoc, pageNumber, captureOptions);
    results.push(image);
  }
  
  return results;
}

/**
 * Capture all pages from a PDF document
 */
export async function captureAllPages(
  pdfDoc: PDFDocumentProxy,
  options: {
    scale?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
    onProgress?: (current: number, total: number) => void;
  } = {}
): Promise<CapturedImage[]> {
  const pageNumbers = Array.from(
    { length: pdfDoc.numPages },
    (_, i) => i + 1
  );
  
  return captureMultiplePages(pdfDoc, pageNumbers, options);
}

/**
 * Get optimal scale for AI analysis based on page dimensions
 * Targets ~2600px on the longest edge for better symbol clarity
 */
export function getOptimalScale(pageWidth: number, pageHeight: number): number {
  const targetSize = 3200;
  const longestEdge = Math.max(pageWidth, pageHeight);
  
  if (longestEdge <= targetSize) {
    return 2; // Upscale small pages for symbol clarity
  }
  
  return Math.max(1, targetSize / longestEdge);
}

/**
 * Render a high-fidelity overview and overlapping 3x3 detail tiles. The page
 * is rendered only twice (overview + tile source), avoiding the old behavior
 * that re-rendered the entire PDF once for every crop.
 */
export async function capturePageVisionBundle(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  options: {
    overviewScale?: number;
    tileScale?: number;
    rows?: number;
    cols?: number;
    overlapRatio?: number;
    maxImageBytes?: number;
    region?: { x: number; y: number; width: number; height: number };
  } = {}
): Promise<PageVisionBundle> {
  const overviewScale = options.overviewScale ?? getOptimalScale(pageWidth, pageHeight);
  const tileScale = options.tileScale ?? 3;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const analysisRegion = options.region || { x: 0, y: 0, width: pageWidth, height: pageHeight };
  const overviewSource = await renderPageForOcr(pdfDoc, pageNumber, Math.round(overviewScale * 72));
  const overviewScaleX = overviewSource.width / Math.max(1, pageWidth);
  const overviewScaleY = overviewSource.height / Math.max(1, pageHeight);
  const overviewCanvas = document.createElement('canvas');
  overviewCanvas.width = Math.max(1, Math.ceil(analysisRegion.width * overviewScaleX));
  overviewCanvas.height = Math.max(1, Math.ceil(analysisRegion.height * overviewScaleY));
  const overviewContext = overviewCanvas.getContext('2d');
  if (!overviewContext) throw new Error('Failed to create AI overview crop');
  overviewContext.drawImage(
    overviewSource,
    Math.floor(analysisRegion.x * overviewScaleX),
    Math.floor(analysisRegion.y * overviewScaleY),
    overviewCanvas.width,
    overviewCanvas.height,
    0,
    0,
    overviewCanvas.width,
    overviewCanvas.height
  );
  const overviewExport = exportCanvasWithinLimit(overviewCanvas, maxImageBytes);
  const overview: CapturedImage = {
    ...overviewExport,
    page: pageNumber,
    scale: overviewExport.width / Math.max(1, analysisRegion.width),
  };

  const tileSource = await renderPageForOcr(pdfDoc, pageNumber, Math.round(tileScale * 72));
  const sourceScaleX = tileSource.width / Math.max(1, pageWidth);
  const sourceScaleY = tileSource.height / Math.max(1, pageHeight);
  const regions = generateOverlappingTileRegions(
    analysisRegion.width,
    analysisRegion.height,
    options.rows,
    options.cols,
    options.overlapRatio
  ).map(region => ({
    ...region,
    x: region.x + analysisRegion.x,
    y: region.y + analysisRegion.y,
    ownership: {
      ...region.ownership,
      x: region.ownership.x + analysisRegion.x,
      y: region.ownership.y + analysisRegion.y,
    },
  }));

  const tiles = regions.map((region): CapturedPageTile => {
    const sx = Math.max(0, Math.floor(region.x * sourceScaleX));
    const sy = Math.max(0, Math.floor(region.y * sourceScaleY));
    const sw = Math.max(1, Math.min(tileSource.width - sx, Math.ceil(region.width * sourceScaleX)));
    const sh = Math.max(1, Math.min(tileSource.height - sy, Math.ceil(region.height * sourceScaleY)));
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = sw;
    tileCanvas.height = sh;
    const context = tileCanvas.getContext('2d');
    if (!context) throw new Error(`Failed to create AI tile ${region.id}`);
    context.drawImage(tileSource, sx, sy, sw, sh, 0, 0, sw, sh);
    const exported = exportCanvasWithinLimit(tileCanvas, maxImageBytes);

    return {
      ...exported,
      page: pageNumber,
      scale: exported.width / Math.max(1, region.width),
      region,
    };
  });

  return { page: pageNumber, pageWidth, pageHeight, overview, tiles };
}

/**
 * Compress an image if it exceeds size limits
 * GPT-4V has a ~20MB limit per image
 */
export async function compressImageIfNeeded(
  base64: string,
  maxSizeBytes: number = 10 * 1024 * 1024 // 10MB default
): Promise<string> {
  // Calculate current size (base64 is ~33% larger than binary)
  const currentSizeBytes = (base64.length * 3) / 4;
  
  if (currentSizeBytes <= maxSizeBytes) {
    return base64;
  }
  
  // Need to compress - convert to canvas and re-export with lower quality
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = base64;
  });
  
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  
  ctx.drawImage(img, 0, 0);
  
  // Try progressively lower quality until under limit
  let quality = 0.8;
  let result = canvas.toDataURL('image/jpeg', quality);
  
  while ((result.length * 3) / 4 > maxSizeBytes && quality > 0.3) {
    quality -= 0.1;
    result = canvas.toDataURL('image/jpeg', quality);
  }
  
  // If still too large, scale down
  if ((result.length * 3) / 4 > maxSizeBytes) {
    const scaleFactor = Math.sqrt(maxSizeBytes / ((result.length * 3) / 4));
    canvas.width = Math.floor(img.width * scaleFactor);
    canvas.height = Math.floor(img.height * scaleFactor);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    result = canvas.toDataURL('image/jpeg', 0.85);
  }
  
  return result;
}

/**
 * Create a function that captures pages from a specific document
 * Useful for the pipeline which needs an image generator function
 */
export function createPageImageGenerator(
  pdfDoc: PDFDocumentProxy,
  options: {
    scale?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
  } = {}
): (page: number) => Promise<string> {
  return async (page: number) => {
    const image = await capturePageImage(pdfDoc, page, options);
    return image.base64;
  };
}

/**
 * Capture a crop from a PDF page and return base64 + crop metadata.
 */
export async function capturePageCrop(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  crop: { x: number; y: number; width: number; height: number },
  options: {
    scale?: number;
    format?: 'png' | 'jpeg';
    quality?: number;
  } = {}
): Promise<CapturedImage & { crop: { x: number; y: number; width: number; height: number } }> {
  const { scale = 2, format = 'jpeg', quality = 0.9 } = options;
  const dpi = Math.max(72, Math.round(scale * 72));
  const canvas = await renderPageForOcr(pdfDoc, pageNumber, dpi);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context for crop');
  }
  
  const scaleFactor = dpi / 72;
  const sx = Math.max(0, Math.floor(crop.x * scaleFactor));
  const sy = Math.max(0, Math.floor(crop.y * scaleFactor));
  const sw = Math.min(canvas.width - sx, Math.floor(crop.width * scaleFactor));
  const sh = Math.min(canvas.height - sy, Math.floor(crop.height * scaleFactor));
  
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = sw;
  cropCanvas.height = sh;
  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) {
    throw new Error('Failed to get crop canvas context');
  }
  
  cropCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const base64 = cropCanvas.toDataURL(mimeType, quality);
  
  return {
    base64,
    width: cropCanvas.width,
    height: cropCanvas.height,
    page: pageNumber,
    scale,
    crop,
  };
}
