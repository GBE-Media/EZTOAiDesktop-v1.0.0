import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';
import type { DocPoint, PageCalibration } from './types';

/**
 * Explicit uncalibrated page — do not invent scale/unit.
 */
export function nonePageCalibration(pageNumber: number): PageCalibration {
  return {
    pageNumber,
    method: 'none',
    pixelsPerUnit: null,
    unit: null,
    confidence: 0,
  };
}

/**
 * Build a PageCalibration from a manual two-point measure in DocPoint space.
 * `pixelsPerUnit` is document points per real-world unit (PageCalibration contract).
 */
export function pageCalibrationFromManualMeasure(options: {
  pageNumber: number;
  pointA: DocPoint;
  pointB: DocPoint;
  knownDistance: number;
  unit: string;
  confidence?: number;
}): PageCalibration {
  const dx = options.pointB.x - options.pointA.x;
  const dy = options.pointB.y - options.pointA.y;
  const docDistance = Math.sqrt(dx * dx + dy * dy);
  const known = options.knownDistance;

  if (
    !Number.isFinite(docDistance)
    || docDistance <= 0
    || !Number.isFinite(known)
    || known <= 0
    || !options.unit
  ) {
    return nonePageCalibration(options.pageNumber);
  }

  return {
    pageNumber: options.pageNumber,
    method: 'manual',
    pixelsPerUnit: docDistance / known,
    unit: options.unit,
    confidence: typeof options.confidence === 'number' && Number.isFinite(options.confidence)
      ? Math.max(0, Math.min(1, options.confidence))
      : 1,
    source: {
      pointA: { ...options.pointA },
      pointB: { ...options.pointB },
      knownDistance: known,
    },
  };
}

/**
 * Adapt legacy document-wide canvas `scale` (render pixels per unit) into a
 * PageCalibration for a page that has no page-specific entry yet.
 */
export function pageCalibrationFromLegacyGlobal(options: {
  pageNumber: number;
  /** canvasStore.scale — render-space pixels per real-world unit */
  renderPixelsPerUnit: number;
  unit: string;
  /** True only when a real calibration exists (not the default scale=1 placeholder). */
  isCalibrated: boolean;
}): PageCalibration {
  if (
    !options.isCalibrated
    || !Number.isFinite(options.renderPixelsPerUnit)
    || options.renderPixelsPerUnit <= 0
    || !options.unit
  ) {
    return nonePageCalibration(options.pageNumber);
  }

  return {
    pageNumber: options.pageNumber,
    method: 'manual',
    // Render px/unit → DocPoint/unit
    pixelsPerUnit: options.renderPixelsPerUnit / BASE_RENDER_SCALE,
    unit: options.unit,
    confidence: 0.95,
  };
}

/**
 * Prefer page-specific calibration. Optional `legacy` is only for a genuine
 * document-wide default (not "last page measured"). Callers that treat every
 * calibration as page-specific should pass legacy: null so uncalibrated pages
 * resolve to method: 'none'.
 */
export function resolvePageCalibration(options: {
  pageNumber: number;
  pageSpecific?: PageCalibration | null;
  legacy?: {
    renderPixelsPerUnit: number;
    unit: string;
    isCalibrated: boolean;
  } | null;
}): PageCalibration {
  const specific = options.pageSpecific;
  if (
    specific
    && specific.method !== 'none'
    && typeof specific.pixelsPerUnit === 'number'
    && Number.isFinite(specific.pixelsPerUnit)
    && specific.pixelsPerUnit > 0
  ) {
    return {
      ...specific,
      pageNumber: options.pageNumber,
    };
  }

  if (options.legacy) {
    return pageCalibrationFromLegacyGlobal({
      pageNumber: options.pageNumber,
      renderPixelsPerUnit: options.legacy.renderPixelsPerUnit,
      unit: options.legacy.unit,
      isCalibrated: options.legacy.isCalibrated,
    });
  }

  return nonePageCalibration(options.pageNumber);
}

/** Convert PageCalibration doc-points/unit back to render-space px/unit for markup tools. */
export function pageCalibrationToRenderPixelsPerUnit(
  calibration: PageCalibration,
): number | null {
  if (
    calibration.method === 'none'
    || calibration.pixelsPerUnit == null
    || !Number.isFinite(calibration.pixelsPerUnit)
    || calibration.pixelsPerUnit <= 0
  ) {
    return null;
  }
  return calibration.pixelsPerUnit * BASE_RENDER_SCALE;
}

/** Convert a render-space point (BASE_RENDER_SCALE canvas) to DocPoint. */
export function renderPointToDocPoint(point: { x: number; y: number }): DocPoint {
  const scale = BASE_RENDER_SCALE > 0 ? BASE_RENDER_SCALE : 1;
  return {
    x: point.x / scale,
    y: point.y / scale,
  };
}
