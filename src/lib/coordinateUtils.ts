import type { Point } from '@/types/markup';

/**
 * Canvas zoom / render-space helpers.
 *
 * IMPORTANT — two different coordinate spaces exist in this app:
 *
 * 1. **Render space** (this module): pixel coordinates on the rendered PDF
 *    canvas at BASE_RENDER_SCALE (1.5). Markup x/y/width/height on the canvas
 *    and most editor hit-testing live here. Historically mislabeled "PDF"
 *    coordinates in this file.
 *
 * 2. **Document / PDF page points** (`DocPoint` in
 *    `src/services/ai/placement/types.ts`): true PDF page points at scale 1,
 *    top-left origin. Placement verification, snapping, and AI DocPoint
 *    contracts use that space — not these helpers.
 *
 * These functions only convert between **screen** (after UI zoom %) and
 * **render** (pre-zoom canvas pixels). They do NOT convert to/from DocPoint.
 */

/** Base scale used for PDF page rasterization (Canvas / pdfLoader). */
export const BASE_RENDER_SCALE = 1.5;

/**
 * Convert screen coordinates to render-space coordinates.
 * Screen = what we see after zoom is applied.
 * Render = canvas/markup storage space at BASE_RENDER_SCALE (100% zoom).
 */
export function screenToRender(screenX: number, screenY: number, zoom: number): Point {
  const scale = zoom / 100;
  return {
    x: screenX / scale,
    y: screenY / scale,
  };
}

/**
 * Convert render-space coordinates to screen coordinates.
 * Used when drawing markups — transforms stored render coords to current zoom.
 */
export function renderToScreen(renderX: number, renderY: number, zoom: number): Point {
  const scale = zoom / 100;
  return {
    x: renderX * scale,
    y: renderY * scale,
  };
}

/**
 * Convert a dimension (width/height) from screen to render space.
 */
export function screenDimensionToRender(screenDimension: number, zoom: number): number {
  const scale = zoom / 100;
  return screenDimension / scale;
}

/**
 * Convert a dimension (width/height) from render to screen space.
 */
export function renderDimensionToScreen(renderDimension: number, zoom: number): number {
  const scale = zoom / 100;
  return renderDimension * scale;
}

/**
 * Transform an array of points from screen to render space.
 */
export function screenPointsToRender(points: Point[], zoom: number): Point[] {
  return points.map(p => screenToRender(p.x, p.y, zoom));
}

/**
 * Transform an array of points from render to screen space.
 */
export function renderPointsToScreen(points: Point[], zoom: number): Point[] {
  return points.map(p => renderToScreen(p.x, p.y, zoom));
}
