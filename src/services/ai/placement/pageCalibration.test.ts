import { describe, expect, it } from 'vitest';
import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';
import {
  nonePageCalibration,
  pageCalibrationFromLegacyGlobal,
  pageCalibrationFromManualMeasure,
  pageCalibrationToRenderPixelsPerUnit,
  resolvePageCalibration,
} from './pageCalibration';

describe('pageCalibration', () => {
  it('builds distinct per-page calibrations that do not share scale', () => {
    const page1 = pageCalibrationFromManualMeasure({
      pageNumber: 1,
      pointA: { x: 0, y: 0 },
      pointB: { x: 100, y: 0 },
      knownDistance: 10,
      unit: 'ft',
    });
    const page5 = pageCalibrationFromManualMeasure({
      pageNumber: 5,
      pointA: { x: 0, y: 0 },
      pointB: { x: 50, y: 0 },
      knownDistance: 10,
      unit: 'm',
    });

    expect(page1.method).toBe('manual');
    expect(page1.pixelsPerUnit).toBeCloseTo(10); // 100 doc-pt / 10 ft
    expect(page1.unit).toBe('ft');

    expect(page5.pixelsPerUnit).toBeCloseTo(5); // 50 doc-pt / 10 m
    expect(page5.unit).toBe('m');
    expect(page5.pixelsPerUnit).not.toBe(page1.pixelsPerUnit);

    expect(resolvePageCalibration({
      pageNumber: 1,
      pageSpecific: page1,
      legacy: { renderPixelsPerUnit: 999, unit: 'ft', isCalibrated: true },
    }).pixelsPerUnit).toBeCloseTo(10);

    expect(resolvePageCalibration({
      pageNumber: 5,
      pageSpecific: page5,
      legacy: { renderPixelsPerUnit: 999, unit: 'ft', isCalibrated: true },
    }).pixelsPerUnit).toBeCloseTo(5);
  });

  it('falls back to legacy global calibration when a page has no specific entry', () => {
    const legacyRenderPxPerUnit = 30; // render-space (canvasStore.scale)
    const resolved = resolvePageCalibration({
      pageNumber: 3,
      pageSpecific: null,
      legacy: {
        renderPixelsPerUnit: legacyRenderPxPerUnit,
        unit: 'ft',
        isCalibrated: true,
      },
    });

    expect(resolved.method).toBe('manual');
    expect(resolved.unit).toBe('ft');
    expect(resolved.pixelsPerUnit).toBeCloseTo(legacyRenderPxPerUnit / BASE_RENDER_SCALE);
    expect(pageCalibrationToRenderPixelsPerUnit(resolved)).toBeCloseTo(legacyRenderPxPerUnit);
  });

  it('returns method none when neither page-specific nor legacy calibration exists', () => {
    expect(resolvePageCalibration({
      pageNumber: 2,
      pageSpecific: nonePageCalibration(2),
      legacy: { renderPixelsPerUnit: 1, unit: 'ft', isCalibrated: false },
    })).toMatchObject({
      pageNumber: 2,
      method: 'none',
      pixelsPerUnit: null,
      unit: null,
    });

    expect(pageCalibrationFromLegacyGlobal({
      pageNumber: 1,
      renderPixelsPerUnit: 1,
      unit: 'ft',
      isCalibrated: false,
    }).method).toBe('none');
  });

  it('does not invent calibration when legacy is omitted (page-specific-only mode)', () => {
    expect(resolvePageCalibration({
      pageNumber: 5,
      pageSpecific: null,
      legacy: null,
    })).toMatchObject({
      pageNumber: 5,
      method: 'none',
      pixelsPerUnit: null,
      unit: null,
    });
  });

  it('round-trips render px/unit through DocPoint PageCalibration', () => {
    // Manual measure in doc space equivalent to 45 render px per unit
    const docPerUnit = 45 / BASE_RENDER_SCALE;
    const cal = pageCalibrationFromManualMeasure({
      pageNumber: 1,
      pointA: { x: 0, y: 0 },
      pointB: { x: docPerUnit * 2, y: 0 },
      knownDistance: 2,
      unit: 'ft',
    });
    expect(pageCalibrationToRenderPixelsPerUnit(cal)).toBeCloseTo(45);
  });
});
