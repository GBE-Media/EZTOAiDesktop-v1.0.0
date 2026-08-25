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

/**
 * Manual measure-area formula (MarkupCanvas):
 *   value = width * height of axis-aligned bounds in render pixels
 *   scaledValue = value / (renderPixelsPerUnit ^ 2)  (when calibrated)
 */
export function computeAreaMeasurementFromBounds(
  points: Point[],
  scale: MeasurementScaleInput,
): MeasurementComputation {
  if (points.length === 0) {
    return finalizeAreaMeasurement(0, scale);
  }
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const areaPixels = Math.max(0, width) * Math.max(0, height);
  return finalizeAreaMeasurement(areaPixels, scale);
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
