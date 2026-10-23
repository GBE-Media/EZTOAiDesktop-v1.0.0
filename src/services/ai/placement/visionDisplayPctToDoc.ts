import { createPageGeometry, getRenderPageSize, renderRectToDoc, renderToDoc } from './coords';
import type { DocPoint, DocRect, PageGeometry, PageRotationDeg } from './types';

export type DisplayCrop = { x: number; y: number; width: number; height: number };

/**
 * Vision detections are 0–100 of the *displayed* page (pdf.js viewport, including
 * page.rotate). Placement stores unrotated DocPoints and apply rotation at render.
 *
 * Convert: display-percent → render point (scale 1) → unrotated DocPoint.
 * Optional crop is in display points at scale 1 (the captured image region).
 */
export function visionDisplayPctToDoc(
  location: { x: number; y: number },
  page: PageGeometry,
  crop?: DisplayCrop,
): DocPoint {
  const identity: PageGeometry = { ...page, renderScale: 1 };
  const display = getRenderPageSize(identity);
  const region = crop && crop.width > 0 && crop.height > 0
    ? crop
    : { x: 0, y: 0, width: display.width, height: display.height };
  const renderPoint = {
    x: region.x + (clampPct(location.x) / 100) * region.width,
    y: region.y + (clampPct(location.y) / 100) * region.height,
  };
  return renderToDoc(renderPoint, identity);
}

export function visionDisplayPctRectToDoc(
  bounds: { x: number; y: number; width: number; height: number },
  page: PageGeometry,
  crop?: DisplayCrop,
): DocRect {
  const identity: PageGeometry = { ...page, renderScale: 1 };
  const display = getRenderPageSize(identity);
  const region = crop && crop.width > 0 && crop.height > 0
    ? crop
    : { x: 0, y: 0, width: display.width, height: display.height };
  const renderRect = {
    x: region.x + (clampPct(bounds.x) / 100) * region.width,
    y: region.y + (clampPct(bounds.y) / 100) * region.height,
    width: (clampPct(bounds.width) / 100) * region.width,
    height: (clampPct(bounds.height) / 100) * region.height,
  };
  return renderRectToDoc(renderRect, identity);
}

export function visionLocationToDocPoint(
  location: { x: number; y: number } | undefined,
  page: PageGeometry | null | undefined,
  crop?: DisplayCrop,
): DocPoint | null {
  if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) return null;
  if (!page || page.docWidth <= 0 || page.docHeight <= 0) return null;
  return visionDisplayPctToDoc(location, page, crop);
}

export function pageGeometryFromUnrotated(options: {
  pageNumber: number;
  docWidth: number;
  docHeight: number;
  rotationDeg?: PageRotationDeg;
}): PageGeometry {
  return createPageGeometry({
    pageNumber: options.pageNumber,
    docWidth: options.docWidth,
    docHeight: options.docHeight,
    renderScale: 1,
    rotationDeg: options.rotationDeg ?? 0,
  });
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
