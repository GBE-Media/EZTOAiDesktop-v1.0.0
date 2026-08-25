import { describe, expect, it } from 'vitest';
import {
  computeAreaMeasurementFromBounds,
  computeLengthMeasurement,
  UNCALIBRATED_MEASUREMENT_NOTE,
} from './measurementValues';
import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';

describe('measurementValues (shared manual + AI formulas)', () => {
  it('computes calibrated length matching MarkupCanvas distance / renderPixelsPerUnit', () => {
    // Manual tool: 150 render-px segment, 30 render-px per foot → 5 ft
    const result = computeLengthMeasurement(
      { x: 0, y: 0 },
      { x: 150, y: 0 },
      { renderPixelsPerUnit: 30, unit: 'ft' },
    );
    expect(result.calibrated).toBe(true);
    expect(result.value).toBe(150);
    expect(result.scaledValue).toBeCloseTo(5, 10);
    expect(result.unit).toBe('ft');
    expect(result.note).toBeUndefined();
  });

  it('computes calibrated area matching MarkupCanvas area / scale^2', () => {
    // 60×40 render-px box, 20 px/ft → (2400) / 400 = 6 sq ft
    const result = computeAreaMeasurementFromBounds(
      [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 40 },
        { x: 0, y: 40 },
      ],
      { renderPixelsPerUnit: 20, unit: 'ft' },
    );
    expect(result.calibrated).toBe(true);
    expect(result.value).toBe(2400);
    expect(result.scaledValue).toBeCloseTo(6, 10);
    expect(result.unit).toBe('sq ft');
  });

  it('returns raw value with uncalibrated note instead of silent 0', () => {
    const length = computeLengthMeasurement(
      { x: 0, y: 0 },
      { x: 90, y: 0 },
      { renderPixelsPerUnit: null, unit: null },
    );
    expect(length.calibrated).toBe(false);
    expect(length.value).toBe(90);
    expect(length.scaledValue).toBe(90);
    expect(length.note).toBe(UNCALIBRATED_MEASUREMENT_NOTE);
    expect(length.unit).toMatch(/uncalibrated/i);

    // Sanity: DocPoint 100 units at BASE_RENDER_SCALE → 150 render px
    expect(100 * BASE_RENDER_SCALE).toBe(150);
  });
});
