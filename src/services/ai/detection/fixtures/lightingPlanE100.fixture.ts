import type { DetectedItem } from '../../providers/types';
import type { LegendEntry } from '../legendAwareCounting';

/**
 * Synthetic single-page lighting-plan harness inspired by the live E-100 failure.
 * Ground-truth counts are manually fixed; "messyVision" simulates the pre-fix
 * vision labels that caused B-NL / A-EM-NL confusion and wrong per-type tallies.
 */

export const E100_LEGEND_LINES = [
  'LIGHTING FIXTURE SCHEDULE',
  'TYPE A - 2x4 RECESSED LED TROFFER',
  'TYPE A/EM/NL - RECESSED LED WITH EMERGENCY AND NIGHT LIGHT',
  'TYPE B - SURFACE CYLINDER',
  'TYPE B-NL - NIGHT LIGHT FIXTURE',
  'TYPE B1 - WALL WASHER',
  'TYPE C - PENDANT',
  'TYPE D - DOWNLIGHT',
  'TYPE S - STRIP LIGHT',
  'TYPE LT/FN - LIGHT FAN COMBO',
  'TYPE EX1 - EXIT SIGN',
  'TYPE EM1 - EMERGENCY UNIT',
  'TYPE ER1 - EMERGENCY REMOTE',
];

/** Manually verified ground truth for the synthetic plan. */
export const E100_GROUND_TRUTH: Record<string, number> = {
  A: 8,
  'A/EM/NL': 1,
  B: 3,
  'B-NL': 1,
  B1: 4,
  C: 0,
  D: 1,
  S: 3,
  'LT/FN': 1,
  EX1: 3,
  EM1: 0,
  ER1: 2,
};

export const E100_LEGEND_ENTRIES: LegendEntry[] = Object.keys(E100_GROUND_TRUTH).map((typeCode) => ({
  typeCode,
  description: E100_LEGEND_LINES.find((l) => l.includes(`TYPE ${typeCode}`))?.split(' - ')[1] || typeCode,
  source: 'schedule' as const,
}));

function det(
  id: string,
  type: string,
  name: string,
  confidence = 0.9,
): DetectedItem {
  return {
    id,
    type,
    name,
    trade: 'electrical',
    quantity: 1,
    location: { x: 10, y: 10 },
    confidence,
  };
}

/**
 * Messy vision output: many items labeled with generic names or base letters,
 * which is what produced wrong preliminary counts before legend grounding.
 * Intentionally mislabels B-NL as B and A/EM/NL as A (the reported failure mode).
 */
export function buildE100MessyVisionDetections(): DetectedItem[] {
  const items: DetectedItem[] = [];
  let n = 0;
  const push = (type: string, name: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      items.push(det(`messy_${n}`, type, name));
    }
  };

  // Correct-ish A detections
  push('A', 'Type A recessed', 8);
  // Variant wrongly labeled as plain A (should be A/EM/NL)
  push('A', 'recessed emergency night light', 1);
  // B detections
  push('B', 'Type B cylinder', 3);
  // B-NL wrongly labeled as B (reported confusion)
  push('B', 'night light', 1);
  push('B1', 'Type B1 wall washer', 4);
  // C: none
  push('D', 'downlight', 1);
  push('S', 'strip light', 3);
  push('LT/FN', 'light fan', 1);
  push('EX1', 'exit sign', 3);
  // EM1: none
  push('ER1', 'emergency remote', 2);

  return items;
}

/** Ideal vision output already using exact legend codes (upper bound). */
export function buildE100CleanVisionDetections(): DetectedItem[] {
  const items: DetectedItem[] = [];
  let n = 0;
  for (const [type, count] of Object.entries(E100_GROUND_TRUTH)) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      items.push(det(`clean_${n}`, type, type));
    }
  }
  return items;
}

export function exactMatchRate(
  actual: Record<string, number>,
  expected: Record<string, number>,
): { rate: number; mismatches: Array<{ type: string; expected: number; actual: number }> } {
  const types = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches: Array<{ type: string; expected: number; actual: number }> = [];
  let matched = 0;
  for (const type of types) {
    const e = expected[type] || 0;
    const a = actual[type] || 0;
    if (e === a) matched += 1;
    else mismatches.push({ type, expected: e, actual: a });
  }
  return { rate: types.size === 0 ? 1 : matched / types.size, mismatches };
}
