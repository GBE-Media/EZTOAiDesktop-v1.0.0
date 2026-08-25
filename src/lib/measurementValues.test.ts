import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeAreaMeasurementFromBounds,
  computeAreaMeasurementFromPoints,
  computeLengthMeasurement,
  computeLengthMeasurementFromPoints,
  polygonAreaShoelace,
  UNCALIBRATED_MEASUREMENT_NOTE,
} from './measurementValues';
import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';
import { convertPlacementsToMarkups } from '@/services/ai/placement/convertPlacements';
import { createPageGeometry } from '@/services/ai/placement/coords';
import type { CanvasPlacement, PlacementMarkup } from '@/services/ai/providers/types';
import type { MarkupStyle } from '@/types/markup';

describe('measurementValues (shared manual + AI formulas)', () => {
  it('computes calibrated length matching MarkupCanvas distance / renderPixelsPerUnit', () => {
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

  it('computes multi-point path length (sum of segments)', () => {
    // (0,0)→(30,0)→(30,40) = 30 + 40 = 70
    const result = computeLengthMeasurementFromPoints(
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 40 },
      ],
      { renderPixelsPerUnit: 10, unit: 'ft' },
    );
    expect(result.value).toBeCloseTo(70, 10);
    expect(result.scaledValue).toBeCloseTo(7, 10);
  });

  it('computes calibrated rectangle area matching MarkupCanvas area / scale^2', () => {
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
    expect(result.areaMethod).toBe('rectangle');
  });

  it('uses shoelace for a triangle (not AABB)', () => {
    // Right triangle (0,0)-(40,0)-(0,30): area = 40*30/2 = 600
    // AABB would wrongly be 40*30 = 1200
    const triangle = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 0, y: 30 },
    ];
    expect(polygonAreaShoelace(triangle)).toBeCloseTo(600, 10);
    const result = computeAreaMeasurementFromPoints(triangle, {
      renderPixelsPerUnit: null,
      unit: null,
    });
    expect(result.areaMethod).toBe('polygon');
    expect(result.value).toBeCloseTo(600, 10);
    expect(result.value).not.toBe(1200);
  });

  it('uses shoelace for an L-shaped polygon (not AABB)', () => {
    // Unit L: outer 4×4 square minus 2×2 inner corner → area 16-4 = 12
    // Vertices (clockwise): (0,0)-(4,0)-(4,2)-(2,2)-(2,4)-(0,4)
    const lShape = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(polygonAreaShoelace(lShape)).toBeCloseTo(12, 10);
    const aabbWouldBe = 4 * 4; // 16
    const result = computeAreaMeasurementFromPoints(lShape, {
      renderPixelsPerUnit: 1,
      unit: 'ft',
    });
    expect(result.areaMethod).toBe('polygon');
    expect(result.value).toBeCloseTo(12, 10);
    expect(result.value).not.toBe(aabbWouldBe);
    expect(result.scaledValue).toBeCloseTo(12, 10);
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
    expect(100 * BASE_RENDER_SCALE).toBe(150);
  });
});

describe('AI measurement-area placement integration', () => {
  const style: MarkupStyle = {
    strokeColor: '#111',
    fillColor: 'transparent',
    strokeWidth: 1,
    opacity: 1,
  };

  function placement(
    overrides: Partial<PlacementMarkup> & Pick<PlacementMarkup, 'id' | 'type' | 'points'>,
  ): PlacementMarkup {
    return {
      page: 1,
      style: {
        strokeColor: '#111',
        fillColor: 'transparent',
        strokeWidth: 1,
      },
      pending: false,
      ...overrides,
    };
  }

  it('place_markups path stores shoelace area for a triangular measurement-area', () => {
    const page = createPageGeometry({
      pageNumber: 1,
      docWidth: 612,
      docHeight: 792,
      renderScale: BASE_RENDER_SCALE,
    });
    // DocPoints → ×1.5 render. Triangle (0,0)-(40,0)-(0,30) in doc →
    // render (0,0)-(60,0)-(0,45); area = 60*45/2 = 1350
    const placements: CanvasPlacement = {
      notes: [],
      markups: [placement({
        id: 'area-tri',
        type: 'measurement-area',
        points: [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 0, y: 30 },
        ],
      })],
    };
    const result = convertPlacementsToMarkups(
      placements,
      style,
      'g',
      BASE_RENDER_SCALE,
      BASE_RENDER_SCALE,
      undefined,
      new Map([[1, page]]),
      new Map([[1, null]]),
    );
    const markup = result[0].markup as {
      type: string;
      value: number;
      calibrated?: boolean;
    };
    expect(markup.type).toBe('measurement-area');
    expect(markup.value).toBeCloseTo(1350, 5);
    expect(markup.calibrated).toBe(false);
  });
});
