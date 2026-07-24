import { describe, expect, it } from 'vitest';
import { calculateVisionAccuracy, type AccuracyPoint } from './visionAccuracy';

const vectorPlanFixture: AccuracyPoint[] = [
  { type: 'duplex receptacle', xPct: 12, yPct: 18 },
  { type: 'duplex receptacle', xPct: 48, yPct: 51 },
  { type: 'panel', xPct: 83, yPct: 77 },
];

const scannedPlanFixture: AccuracyPoint[] = [
  { type: 'supply diffuser', xPct: 20, yPct: 25 },
  { type: 'supply diffuser', xPct: 70, yPct: 65 },
];

describe('calculateVisionAccuracy', () => {
  it('reports perfect vector-plan fixture results within pointer tolerance', () => {
    const predicted = vectorPlanFixture.map(point => ({
      ...point,
      xPct: point.xPct + 0.4,
      yPct: point.yPct - 0.3,
    }));
    const metrics = calculateVisionAccuracy(predicted, vectorPlanFixture);

    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
    expect(metrics.countError).toBe(0);
    expect(metrics.meanPointerErrorPct).toBeLessThan(1);
  });

  it('exposes misses and count error for a scanned-plan fixture', () => {
    const metrics = calculateVisionAccuracy(scannedPlanFixture.slice(0, 1), scannedPlanFixture);

    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.countError).toBe(-1);
  });
});
