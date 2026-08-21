import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';
import type { DocPoint, DocRect, PageGeometry, PageRotationDeg } from './types';
import { DEFAULT_RENDER_SCALE } from './types';

// DocPoint ↔ render-canvas transforms (true PDF page points at scale 1).
// Do not confuse with screen↔render zoom helpers in `@/lib/coordinateUtils`
// (those operate on render-space markup pixels, historically misnamed "PDF").

export { BASE_RENDER_SCALE, DEFAULT_RENDER_SCALE };

export function createPageGeometry(options: {
  pageNumber: number;
  docWidth: number;
  docHeight: number;
  renderScale?: number;
  rotationDeg?: PageRotationDeg;
}): PageGeometry {
  const rotationDeg = normalizeRotationDeg(options.rotationDeg);
  return {
    pageNumber: options.pageNumber,
    docWidth: Math.max(1, options.docWidth),
    docHeight: Math.max(1, options.docHeight),
    renderScale: options.renderScale ?? DEFAULT_RENDER_SCALE,
    rotationDeg,
  };
}

/** Explicit identity when rotation is missing/invalid — never invent a non-zero angle. */
export function normalizeRotationDeg(value: unknown): PageRotationDeg {
  if (value === 90 || value === 180 || value === 270) return value;
  return 0;
}

/**
 * Unscaled doc → rotated display axes (clockwise about top-left page origin).
 * docWidth/docHeight are the unrotated page size.
 */
export function rotateDocPointClockwise(
  point: DocPoint,
  page: Pick<PageGeometry, 'docWidth' | 'docHeight' | 'rotationDeg'>,
): DocPoint {
  const W = page.docWidth;
  const H = page.docHeight;
  const x = point.x;
  const y = point.y;
  switch (normalizeRotationDeg(page.rotationDeg)) {
    case 90:
      return { x: H - y, y: x };
    case 180:
      return { x: W - x, y: H - y };
    case 270:
      return { x: y, y: W - x };
    case 0:
    default:
      return { x, y };
  }
}

/** Inverse of rotateDocPointClockwise (rotated display → unrotated doc). */
export function unrotateRenderPointToDoc(
  point: DocPoint,
  page: Pick<PageGeometry, 'docWidth' | 'docHeight' | 'rotationDeg'>,
): DocPoint {
  const W = page.docWidth;
  const H = page.docHeight;
  const x = point.x;
  const y = point.y;
  switch (normalizeRotationDeg(page.rotationDeg)) {
    case 90:
      // Inverse of (H - y, x)
      return { x: y, y: H - x };
    case 180:
      return { x: W - x, y: H - y };
    case 270:
      // Inverse of (y, W - x)
      return { x: W - y, y: x };
    case 0:
    default:
      return { x, y };
  }
}

/** Render canvas size in pixels after rotation + scale. */
export function getRenderPageSize(page: PageGeometry): { width: number; height: number } {
  const scale = page.renderScale || DEFAULT_RENDER_SCALE;
  const rot = normalizeRotationDeg(page.rotationDeg);
  if (rot === 90 || rot === 270) {
    return {
      width: page.docHeight * scale,
      height: page.docWidth * scale,
    };
  }
  return {
    width: page.docWidth * scale,
    height: page.docHeight * scale,
  };
}

/** Document points → markup overlay / render-canvas pixels (applies rotationDeg). */
export function docToRender(point: DocPoint, page: PageGeometry): DocPoint {
  const scale = page.renderScale || DEFAULT_RENDER_SCALE;
  const rotated = rotateDocPointClockwise(point, page);
  return { x: rotated.x * scale, y: rotated.y * scale };
}

export function docRectToRender(rect: DocRect, page: PageGeometry): DocRect {
  const corners: DocPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ].map(corner => docToRender(corner, page));

  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** Render-canvas pixels → document points (undoes rotationDeg). */
export function renderToDoc(point: DocPoint, page: PageGeometry): DocPoint {
  const scale = page.renderScale || DEFAULT_RENDER_SCALE;
  if (!Number.isFinite(scale) || scale === 0) {
    return unrotateRenderPointToDoc(point, page);
  }
  const unscaled = { x: point.x / scale, y: point.y / scale };
  return unrotateRenderPointToDoc(unscaled, page);
}

export function renderRectToDoc(rect: DocRect, page: PageGeometry): DocRect {
  const corners: DocPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ].map(corner => renderToDoc(corner, page));

  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** Percent (0–100) → document points. */
export function pctToDoc(xPct: number, yPct: number, page: PageGeometry): DocPoint {
  return {
    x: (clamp(xPct, 0, 100) / 100) * page.docWidth,
    y: (clamp(yPct, 0, 100) / 100) * page.docHeight,
  };
}

export function pctRectToDoc(
  boundsPct: { x: number; y: number; width: number; height: number },
  page: PageGeometry,
): DocRect {
  return {
    x: (clamp(boundsPct.x, 0, 100) / 100) * page.docWidth,
    y: (clamp(boundsPct.y, 0, 100) / 100) * page.docHeight,
    width: (clamp(boundsPct.width, 0, 100) / 100) * page.docWidth,
    height: (clamp(boundsPct.height, 0, 100) / 100) * page.docHeight,
  };
}

export function docToPct(point: DocPoint, page: PageGeometry): { xPct: number; yPct: number } {
  return {
    xPct: (point.x / page.docWidth) * 100,
    yPct: (point.y / page.docHeight) * 100,
  };
}

/**
 * Intersect a DocRect with the page bounds (true AABB intersection).
 * Returns width/height <= 0 when there is no overlap with the page.
 */
export function clampDocRect(rect: DocRect, page: PageGeometry): DocRect {
  const pageLeft = 0;
  const pageTop = 0;
  const pageRight = page.docWidth;
  const pageBottom = page.docHeight;

  const regionRight = rect.x + rect.width;
  const regionBottom = rect.y + rect.height;

  const clampedLeft = Math.max(rect.x, pageLeft);
  const clampedTop = Math.max(rect.y, pageTop);
  const clampedRight = Math.min(regionRight, pageRight);
  const clampedBottom = Math.min(regionBottom, pageBottom);

  const clampedWidth = clampedRight - clampedLeft;
  const clampedHeight = clampedBottom - clampedTop;

  return {
    x: clampedLeft,
    y: clampedTop,
    // Preserve non-positive sizes so callers (e.g. normalizeScopedAnalysisRegion)
    // can detect zero/near-zero or no-overlap without inventing an on-page rect.
    width: clampedWidth,
    height: clampedHeight,
  };
}

export function isRectInPage(rect: DocRect, page: PageGeometry, margin = 0): boolean {
  return (
    rect.x >= -margin
    && rect.y >= -margin
    && rect.x + rect.width <= page.docWidth + margin
    && rect.y + rect.height <= page.docHeight + margin
    && rect.width >= 0
    && rect.height >= 0
  );
}

export function rectCenter(rect: DocRect): DocPoint {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export function roundTripStable(point: DocPoint, page: PageGeometry, epsilon = 0.05): boolean {
  const back = renderToDoc(docToRender(point, page), page);
  return Math.abs(back.x - point.x) <= epsilon && Math.abs(back.y - point.y) <= epsilon;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
