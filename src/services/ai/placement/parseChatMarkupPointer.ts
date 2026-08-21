import type { ChatMarkupPointer } from '../providers/types';
import { createPageGeometry, pctRectToDoc, pctToDoc } from './coords';
import type { DocPoint, DocRect } from './types';

export type PageSizeHint = {
  pageWidth: number;
  pageHeight: number;
};

function asFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readDocPoint(raw: unknown): DocPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const x = asFiniteNumber(row.x);
  const y = asFiniteNumber(row.y);
  if (x === null || y === null) return null;
  return { x, y };
}

function readDocRect(raw: unknown): DocRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const x = asFiniteNumber(row.x);
  const y = asFiniteNumber(row.y);
  const width = asFiniteNumber(row.width);
  const height = asFiniteNumber(row.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function clampPointToPage(point: DocPoint, pageWidth: number, pageHeight: number): DocPoint {
  return {
    x: Math.max(0, Math.min(pageWidth, point.x)),
    y: Math.max(0, Math.min(pageHeight, point.y)),
  };
}

function clampRectToPage(rect: DocRect, pageWidth: number, pageHeight: number): DocRect {
  const x = Math.max(0, Math.min(pageWidth, rect.x));
  const y = Math.max(0, Math.min(pageHeight, rect.y));
  const width = Math.max(0.1, Math.min(pageWidth - x, rect.width));
  const height = Math.max(0.1, Math.min(pageHeight - y, rect.height));
  return { x, y, width, height };
}

/**
 * Parse a model/tool callout row into a ChatMarkupPointer in DocPoint space.
 *
 * Preferred contract: `point: {x,y}` and optional `bounds: {x,y,width,height}`
 * in PDF page points (scale 1, top-left origin).
 *
 * Legacy `xPct`/`yPct`/`boundsPct` (0–100) are accepted only when page size is
 * supplied so they can be converted to DocPoint without inventing geometry.
 */
export function parseChatMarkupPointerRow(
  row: Record<string, unknown>,
  options?: {
    defaultRef?: number;
    pageWidth?: number;
    pageHeight?: number;
  },
): ChatMarkupPointer | null {
  const ref = Number(row.ref ?? options?.defaultRef ?? 0);
  if (!Number.isInteger(ref) || ref < 1) return null;

  const pageWidth = options?.pageWidth;
  const pageHeight = options?.pageHeight;
  const hasPageSize = typeof pageWidth === 'number'
    && typeof pageHeight === 'number'
    && Number.isFinite(pageWidth)
    && Number.isFinite(pageHeight)
    && pageWidth > 0
    && pageHeight > 0;

  let point: DocPoint | null = readDocPoint(row.point);
  if (!point) {
    // Top-level x/y as DocPoints when point object omitted (and not legacy-only).
    const hasLegacyPct = row.xPct != null || row.yPct != null;
    if (!hasLegacyPct) {
      const x = asFiniteNumber(row.x);
      const y = asFiniteNumber(row.y);
      if (x !== null && y !== null) point = { x, y };
    }
  }

  let bounds: DocRect | null = readDocRect(row.bounds);

  // Legacy percent contract → DocPoint when page geometry is known.
  if ((!point || !bounds) && hasPageSize && pageWidth && pageHeight) {
    const page = createPageGeometry({
      pageNumber: 1,
      docWidth: pageWidth,
      docHeight: pageHeight,
    });
    if (!point) {
      const xPct = asFiniteNumber(row.xPct);
      const yPct = asFiniteNumber(row.yPct);
      if (
        xPct !== null
        && yPct !== null
        && xPct >= 0
        && xPct <= 100
        && yPct >= 0
        && yPct <= 100
      ) {
        point = pctToDoc(xPct, yPct, page);
      }
    }
    if (!bounds && row.boundsPct) {
      const pctRect = readDocRect(row.boundsPct);
      if (
        pctRect
        && pctRect.x >= 0
        && pctRect.y >= 0
        && pctRect.x + pctRect.width <= 100.0001
        && pctRect.y + pctRect.height <= 100.0001
        && pctRect.width <= 100
        && pctRect.height <= 100
      ) {
        bounds = pctRectToDoc(pctRect, page);
      }
    }
  }

  if (!point) return null;

  if (hasPageSize && pageWidth && pageHeight) {
    point = clampPointToPage(point, pageWidth, pageHeight);
    if (bounds) bounds = clampRectToPage(bounds, pageWidth, pageHeight);
  }

  const pageRaw = row.page;
  const page = typeof pageRaw === 'number' && Number.isFinite(pageRaw) && pageRaw > 0
    ? pageRaw
    : undefined;

  return {
    type: (typeof row.type === 'string' ? row.type : 'callout') as ChatMarkupPointer['type'],
    ref,
    point,
    bounds: bounds || undefined,
    page,
    label: typeof row.label === 'string'
      ? row.label
      : typeof row.content === 'string'
        ? row.content
        : undefined,
    note: typeof row.note === 'string' ? row.note : undefined,
    confidence: typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      ? Math.max(0, Math.min(1, row.confidence))
      : undefined,
  };
}

/** Convert vision 0–100 detection location/bounds into DocPoint space. */
export function detectionPctToDocPointerFields(
  location: { x: number; y: number },
  boundingBox: { x: number; y: number; width: number; height: number } | undefined,
  pageWidth: number,
  pageHeight: number,
): { point: DocPoint; bounds?: DocRect } {
  const page = createPageGeometry({
    pageNumber: 1,
    docWidth: pageWidth,
    docHeight: pageHeight,
  });
  return {
    point: pctToDoc(location.x, location.y, page),
    bounds: boundingBox ? pctRectToDoc(boundingBox, page) : undefined,
  };
}
