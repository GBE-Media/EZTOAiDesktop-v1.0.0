export interface AccuracyPoint {
  type: string;
  xPct: number;
  yPct: number;
}

export interface VisionAccuracyMetrics {
  precision: number;
  recall: number;
  countError: number;
  meanPointerErrorPct: number;
}

const normalizedType = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');

/**
 * Deterministic benchmark metrics for labeled plan fixtures. A prediction can
 * match only one truth point of the same type within the configured radius.
 */
export function calculateVisionAccuracy(
  predicted: AccuracyPoint[],
  expected: AccuracyPoint[],
  matchRadiusPct: number = 2
): VisionAccuracyMetrics {
  const unmatchedExpected = new Set(expected.map((_, index) => index));
  const errors: number[] = [];
  let matched = 0;

  predicted.forEach(prediction => {
    let bestIndex = -1;
    let bestDistance = Infinity;
    unmatchedExpected.forEach(index => {
      const truth = expected[index];
      if (normalizedType(truth.type) !== normalizedType(prediction.type)) return;
      const distance = Math.hypot(prediction.xPct - truth.xPct, prediction.yPct - truth.yPct);
      if (distance <= matchRadiusPct && distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      unmatchedExpected.delete(bestIndex);
      matched += 1;
      errors.push(bestDistance);
    }
  });

  return {
    precision: predicted.length === 0 ? (expected.length === 0 ? 1 : 0) : matched / predicted.length,
    recall: expected.length === 0 ? 1 : matched / expected.length,
    countError: predicted.length - expected.length,
    meanPointerErrorPct: errors.length === 0
      ? (expected.length === 0 ? 0 : Infinity)
      : errors.reduce((sum, value) => sum + value, 0) / errors.length,
  };
}
