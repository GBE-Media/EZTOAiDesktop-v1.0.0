import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';
import type { DocPoint, DocRect, PageGeometry, PageRotationDeg } from './types';
import { DEFAULT_RENDER_SCALE } from './types';

export { BASE_RENDER_SCALE, DEFAULT_RENDER_SCALE };

export function createPageGeometry(options: {
  pageNumber: number;
  docWidth: number;
  docHeight: number;
  renderScale?: number;
  rotationDeg?: PageRotationDeg;
}): PageGeometry {
  return {
    pageNumber: options.pageNumber,
    docWidth: Math.max(1, options.docWidth),
    docHeight: Math.max(1, options.docHeight),
    renderScale: options.renderScale ?? DEFAULT_RENDER_SCALE,
    rotationDeg: options.rotationDeg ?? 0,
  };
}

/** Document points → markup overlay / render-canvas pixels. */
export function docToRender(point: DocPoint, page: PageGeometry): DocPoint {
  const scale = page.renderScale || DEFAULT_RENDER_SCALE;
  return { x: point.x * scale, y: point.y * scale };
}

export function docRectToRender(rect: DocRect, page: PageGeometry): DocRect {
  const origin = docToRender({ x: rect.x, y: rect.y }, page);
  const scale = page.renderScale || DEFAULT_RENDER_SCALE;
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/** Render-canvas pixels → document points. */
export function renderToDoc(point: DocPoint, page: PageGeometry): DocPoint {
  const scale = page.renderScale || DEFAULT_RENDER_SCALE;
  return { x: point.x / scale, y: point.y / scale };
}

export function renderRectToDoc(rect: DocRect, page: PageGeometry): DocRect {
  const origin = renderToDoc({ x: rect.x, y: rect.y }, page);
  const scale = page.renderScale || DEFAULT_RENDER_SCALE;
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width / scale,
    height: rect.height / scale,
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
