import type { Point } from '@/types/markup';

// Base scale used for PDF rendering (from Canvas.tsx and pdfLoader)
export const BASE_RENDER_SCALE = 1.5;

/**
 * Convert screen coordinates to PDF coordinates.
 * Screen coordinates are what we see on the canvas after zoom is applied.
 * PDF coordinates are the "true" coordinates at 100% zoom (with base scale).
 * 
 * @param screenX - X coordinate in screen space
 * @param screenY - Y coordinate in screen space
 * @param zoom - Current zoom level (percentage, e.g., 100 = 100%)
 * @returns Point in PDF coordinate space
 */
export function screenToPdf(screenX: number, screenY: number, zoom: number): Point {
  const scale = zoom / 100;
  return {
    x: screenX / scale,
    y: screenY / scale,
  };
}

/**
 * Convert PDF coordinates to screen coordinates.
 * Used when rendering markups - transforms stored PDF coordinates to current screen position.
 * 
 * @param pdfX - X coordinate in PDF space
 * @param pdfY - Y coordinate in PDF space
 * @param zoom - Current zoom level (percentage, e.g., 100 = 100%)
 * @returns Point in screen coordinate space
 */
export function pdfToScreen(pdfX: number, pdfY: number, zoom: number): Point {
  const scale = zoom / 100;
  return {
    x: pdfX * scale,
    y: pdfY * scale,
  };
}

/**
 * Convert a dimension (width/height) from screen to PDF space.
 */
export function screenDimensionToPdf(screenDimension: number, zoom: number): number {
  const scale = zoom / 100;
  return screenDimension / scale;
}

/**
 * Convert a dimension (width/height) from PDF to screen space.
 */
export function pdfDimensionToScreen(pdfDimension: number, zoom: number): number {
  const scale = zoom / 100;
  return pdfDimension * scale;
}

/**
 * Transform an array of points from screen to PDF space.
 */
export function screenPointsToPdf(points: Point[], zoom: number): Point[] {
  return points.map(p => screenToPdf(p.x, p.y, zoom));
}

/**
 * Transform an array of points from PDF to screen space.
 */
export function pdfPointsToScreen(points: Point[], zoom: number): Point[] {
  return points.map(p => pdfToScreen(p.x, p.y, zoom));
}
