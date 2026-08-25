import type { Point } from '@/types/markup';

/** Appended to AI measurement aiNote when the page has no scale calibration. */
export const UNCALIBRATED_MEASUREMENT_NOTE = 'uncalibrated, raw units only';

export type MeasurementComputation = {
  /** Raw length/area in render-space pixels (same space manual tools store in `value`). */
  value: number;
  /** Real-world value when calibrated; raw value when not (never a silent 0). */
  scaledValue: number;
  unit: string;
  calibrated: boolean;
  /** Present when calibrated is false — model/UI should not treat scaledValue as real-world. */
  note?: string;
  /** How area was computed (length measurements omit this). */
  areaMethod?: 'rectangle' | 'polygon';
};

export type MeasurementScaleInput = {
  /** Render-space pixels per real-world unit, or null when the page is uncalibrated. */
  renderPixelsPerUnit: number | null;
  /** Real-world unit from PageCalibration (e.g. "ft"), ignored when uncalibrated. */
  unit: string | null;
};

/**
 * Manual measure-length formula (MarkupCanvas):
 *   value = distance(start, end) in render pixels
 *   scaledValue = value / renderPixelsPerUnit  (when calibrated)
 */
export function computeLengthMeasurement(
  start: Point,
  end: Point,
  scale: MeasurementScaleInput,
): MeasurementComputation {
  const value = Math.hypot(end.x - start.x, end.y - start.y);
  return finalizeLinearMeasurement(value, scale);
}

/** Polyline path length in render pixels (sum of consecutive segments). */
export function computePathLength(points: Point[]): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function computeLengthMeasurementFromPoints(
  points: Point[],
  scale: MeasurementScaleInput,
): MeasurementComputation {
  if (points.length < 2) {
    return finalizeLinearMeasurement(0, scale);
  }
  if (points.length === 2) {
    return computeLengthMeasurement(points[0], points[points.length - 1], scale);
  }
  return finalizeLinearMeasurement(computePathLength(points), scale);
}

/** Absolute polygon area via the shoelace formula (closed ring). */
export function polygonAreaShoelace(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** True when points are the four corners of an axis-aligned rectangle (any order). */
export function isAxisAlignedRectanglePoints(points: Point[], epsilon = 1e-6): boolean {
  if (points.length !== 4) return false;
  const xs = [...new Set(points.map(p => p.x))].sort((a, b) => a - b);
  const ys = [...new Set(points.map(p => p.y))].sort((a, b) => a - b);
  if (xs.length !== 2 || ys.length !== 2) return false;
  const [minX, maxX] = xs;
  const [minY, maxY] = ys;
  if (Math.abs(maxX - minX) < epsilon || Math.abs(maxY - minY) < epsilon) return false;
  const expected = new Set([
    `${minX},${minY}`,
    `${maxX},${minY}`,
    `${maxX},${maxY}`,
    `${minX},${maxY}`,
  ]);
  for (const p of points) {
    const key = `${p.x},${p.y}`;
    // Allow tiny float drift by matching nearest expected corner.
    let matched = expected.has(key);
    if (!matched) {
      for (const ex of expected) {
        const [exX, exY] = ex.split(',').map(Number);
        if (Math.abs(exX - p.x) <= epsilon && Math.abs(exY - p.y) <= epsilon) {
          matched = true;
          break;
        }
      }
    }
    if (!matched) return false;
  }
  return true;
}

function aabbArea(points: Point[]): number {
  if (points.length === 0) return 0;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return Math.max(0, width) * Math.max(0, height);
}

/**
 * Area measurement for render-space points.
 *
 * Product intent:
 * - Manual measure-area is a two-corner drag → rectangle (AABB).
 * - AI `measurement-area` schema allows arbitrary polygons; AABB would silently
 *   mis-count L-shapes / triangles. Use shoelace for non-rectangular rings.
 *
 * Rules:
 * - 0–1 points → 0
 * - 2 points → opposite corners of a rectangle (manual tool)
 * - 4 axis-aligned rectangle corners → AABB (same as width×height)
 * - otherwise (triangle, L-shape, free polygon) → shoelace
 */
export function computeAreaMeasurementFromPoints(
  points: Point[],
  scale: MeasurementScaleInput,
): MeasurementComputation {
  if (points.length < 2) {
    return { ...finalizeAreaMeasurement(0, scale), areaMethod: 'rectangle' };
  }
  if (points.length === 2 || isAxisAlignedRectanglePoints(points)) {
    return {
      ...finalizeAreaMeasurement(aabbArea(points), scale),
      areaMethod: 'rectangle',
    };
  }
  return {
    ...finalizeAreaMeasurement(polygonAreaShoelace(points), scale),
    areaMethod: 'polygon',
  };
}

/**
 * @deprecated Prefer computeAreaMeasurementFromPoints — kept as an alias for
 * callers that historically meant AABB/rectangle area.
 */
export function computeAreaMeasurementFromBounds(
  points: Point[],
  scale: MeasurementScaleInput,
): MeasurementComputation {
  return computeAreaMeasurementFromPoints(points, scale);
}

function finalizeLinearMeasurement(
  value: number,
  scale: MeasurementScaleInput,
): MeasurementComputation {
  const raw = Number.isFinite(value) ? value : 0;
  const pxPerUnit = scale.renderPixelsPerUnit;
  if (
    pxPerUnit != null
    && Number.isFinite(pxPerUnit)
    && pxPerUnit > 0
    && scale.unit
  ) {
    return {
      value: raw,
      scaledValue: raw / pxPerUnit,
      unit: scale.unit,
      calibrated: true,
    };
  }
  return {
    value: raw,
    scaledValue: raw,
    unit: 'px (uncalibrated)',
    calibrated: false,
    note: UNCALIBRATED_MEASUREMENT_NOTE,
  };
}

function finalizeAreaMeasurement(
  value: number,
  scale: MeasurementScaleInput,
): MeasurementComputation {
  const raw = Number.isFinite(value) ? value : 0;
  const pxPerUnit = scale.renderPixelsPerUnit;
  if (
    pxPerUnit != null
    && Number.isFinite(pxPerUnit)
    && pxPerUnit > 0
    && scale.unit
  ) {
    const unit = scale.unit === 'ft' ? 'sq ft' : `sq ${scale.unit}`;
    return {
      value: raw,
      scaledValue: raw / (pxPerUnit * pxPerUnit),
      unit,
      calibrated: true,
    };
  }
  return {
    value: raw,
    scaledValue: raw,
    unit: 'sq px (uncalibrated)',
    calibrated: false,
    note: UNCALIBRATED_MEASUREMENT_NOTE,
  };
}
