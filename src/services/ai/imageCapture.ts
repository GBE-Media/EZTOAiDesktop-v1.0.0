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
 * Targets ~2000px on the longest edge for good detail without excessive tokens
 */
export function getOptimalScale(pageWidth: number, pageHeight: number): number {
  const targetSize = 2000;
  const longestEdge = Math.max(pageWidth, pageHeight);
  
  if (longestEdge <= targetSize) {
    return 1.5; // Upscale small pages
  }
  
  return Math.max(1, targetSize / longestEdge);
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
