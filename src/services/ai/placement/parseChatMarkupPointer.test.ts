import { describe, expect, it } from 'vitest';
import {
  detectionPctToDocPointerFields,
  parseChatMarkupPointerRow,
} from './parseChatMarkupPointer';

describe('parseChatMarkupPointerRow', () => {
  it('parses DocPoint point/bounds with fractional precision', () => {
    const pointer = parseChatMarkupPointerRow({
      ref: 1,
      point: { x: 306.25, y: 129.5 },
      bounds: { x: 280.8, y: 100.8, width: 50.4, height: 57.6 },
      label: 'Timeclock',
      confidence: 0.94,
    }, { pageWidth: 720, pageHeight: 540 });

    expect(pointer).toMatchObject({
      ref: 1,
      point: { x: 306.25, y: 129.5 },
      bounds: { x: 280.8, y: 100.8, width: 50.4, height: 57.6 },
      label: 'Timeclock',
      confidence: 0.94,
    });
  });

  it('converts legacy xPct/yPct to DocPoint when page size is known', () => {
    const pointer = parseChatMarkupPointerRow({
      ref: 2,
      xPct: 50,
      yPct: 25,
      boundsPct: { x: 40, y: 20, width: 20, height: 10 },
      label: 'Legacy',
    }, { pageWidth: 1000, pageHeight: 800 });

    expect(pointer?.point).toEqual({ x: 500, y: 200 });
    expect(pointer?.bounds).toEqual({ x: 400, y: 160, width: 200, height: 80 });
  });

  it('rejects legacy percents when page size is unknown (no invented geometry)', () => {
    const pointer = parseChatMarkupPointerRow({
      ref: 3,
      xPct: 50,
      yPct: 50,
    });
    expect(pointer).toBeNull();
  });

  it('accepts top-level x/y as DocPoints when point object is omitted', () => {
    const pointer = parseChatMarkupPointerRow({
      ref: 4,
      x: 12.5,
      y: 99.25,
      label: 'Outlet',
    });
    expect(pointer?.point).toEqual({ x: 12.5, y: 99.25 });
  });
});

describe('detectionPctToDocPointerFields', () => {
  it('maps vision 0–100 percents into DocPoint space', () => {
    const fields = detectionPctToDocPointerFields(
      { x: 52, y: 38 },
      { x: 48, y: 32, width: 8, height: 12 },
      1000,
      800,
    );
    expect(fields.point).toEqual({ x: 520, y: 304 });
    expect(fields.bounds).toEqual({ x: 480, y: 256, width: 80, height: 96 });
  });
});
