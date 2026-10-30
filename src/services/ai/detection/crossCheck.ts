import type { DetectedItem } from '../providers/types';

/**
 * Second-opinion vision reconciliation.
 *
 * The primary vision model and an independent second model read the same detail tiles. Their
 * page-level detections are paired by position (closest first). Agreement raises confidence;
 * disagreement never silently changes a total:
 *  - both models, same type        → confirmed (confidence raised)
 *  - both models, different type   → kept as the primary type; sent to review unless the
 *                                     primary was highly confident (a printed tag can still
 *                                     resolve it later in the pipeline)
 *  - primary only                  → kept; very low-confidence ones go to review
 *  - second model only             → added as a review marker (not counted). A printed type
 *                                     tag beside it later promotes it to a counted fixture.
 * Printed PDF tags and the drawn-symbol check run after this and stay the top authority.
 */

export type CrossCheckOutcome = 'agreed' | 'type_conflict' | 'primary_only' | 'second_only';

export interface CrossCheckStats {
  model: string;
  agreed: number;
  typeConflicts: number;
  primaryOnly: number;
  secondOnly: number;
  /** Primary detections sent to review because of the cross-check. */
  sentToReview: number;
}

export interface CrossCheckResult {
  items: DetectedItem[];
  stats: CrossCheckStats;
}

/** Primary-only detections below this confidence go to review. */
export const PRIMARY_ONLY_REVIEW_CONFIDENCE = 0.4;

const NO_MATCH = 'no_confident_match';

function typeKey(item: DetectedItem): string {
  const code = typeof item.legendTypeCode === 'string' ? item.legendTypeCode.trim().toUpperCase() : '';
  if (code && code !== NO_MATCH.toUpperCase()) return `code:${code}`;
  return `type:${String(item.type || item.name || '').trim().toLowerCase()}`;
}

function isReview(item: DetectedItem): boolean {
  const code = typeof item.legendTypeCode === 'string' ? item.legendTypeCode.trim() : '';
  return code === NO_MATCH || item.matchConfidence === 'low';
}

/** Pairing radius in PDF points: about a fixture symbol's size on a typical sheet. */
export function crossCheckRadiusPt(pageWidth: number, pageHeight: number): number {
  return Math.max(18, 0.008 * Math.max(pageWidth, pageHeight));
}

function note(item: DetectedItem, text: string): string {
  return [item.evidence, text].filter(Boolean).join('; ');
}

export function reconcileCrossCheck(
  primary: DetectedItem[],
  second: DetectedItem[],
  pageWidth: number,
  pageHeight: number,
  options: { model: string; hasLegend: boolean },
): CrossCheckResult {
  const stats: CrossCheckStats = {
    model: options.model,
    agreed: 0,
    typeConflicts: 0,
    primaryOnly: 0,
    secondOnly: 0,
    sentToReview: 0,
  };
  const radius = crossCheckRadiusPt(pageWidth, pageHeight);
  const pt = (item: DetectedItem) => item.locationMissing
    ? null
    : { x: (item.location.x / 100) * pageWidth, y: (item.location.y / 100) * pageHeight };
  const primaryPts = primary.map(pt);
  const secondPts = second.map(pt);

  // Closest pairs first; same type preferred at equal distance. Deterministic tie-break by index.
  const pairs: Array<{ p: number; s: number; d: number; same: boolean }> = [];
  primaryPts.forEach((a, p) => {
    if (!a) return;
    secondPts.forEach((b, s) => {
      if (!b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d <= radius) pairs.push({ p, s, d, same: typeKey(primary[p]) === typeKey(second[s]) });
    });
  });
  pairs.sort((x, y) => Number(y.same) - Number(x.same) || x.d - y.d || x.p - y.p || x.s - y.s);

  const pUsed = new Map<number, number>();
  const sUsed = new Set<number>();
  for (const pair of pairs) {
    if (pUsed.has(pair.p) || sUsed.has(pair.s)) continue;
    pUsed.set(pair.p, pair.s);
    sUsed.add(pair.s);
  }

  const items: DetectedItem[] = primary.map((item, p) => {
    if (item.locationMissing) return item;
    const s = pUsed.get(p);
    if (s === undefined) {
      stats.primaryOnly += 1;
      const low = (item.confidence ?? 1) < PRIMARY_ONLY_REVIEW_CONFIDENCE;
      if (low && options.hasLegend && !isReview(item)) {
        stats.sentToReview += 1;
        return {
          ...item,
          crossCheck: 'primary_only',
          matchConfidence: 'low',
          evidence: note(item, `Low confidence and not seen by the second vision model (${options.model}) — review`),
        };
      }
      return { ...item, crossCheck: 'primary_only' };
    }
    const other = second[s];
    if (typeKey(item) === typeKey(other) || (isReview(item) && isReview(other))) {
      stats.agreed += 1;
      const confidence = Math.min(0.99, Math.max(item.confidence ?? 0, other.confidence ?? 0) + 0.05);
      return {
        ...item,
        crossCheck: 'agreed',
        confidence,
        evidence: note(item, `Confirmed by second vision model (${options.model})`),
      };
    }
    stats.typeConflicts += 1;
    const otherLabel = (other.legendTypeCode && other.legendTypeCode !== NO_MATCH)
      ? other.legendTypeCode
      : other.type || other.name;
    // A primary review item the second model typed confidently: take the second model's type,
    // still as review — the printed tag (if any) decides.
    if (isReview(item) && !isReview(other)) {
      return {
        ...item,
        crossCheck: 'type_conflict',
        evidence: note(item, `Second vision model (${options.model}) read this as ${otherLabel} — review`),
      };
    }
    const keep = !options.hasLegend || item.matchConfidence === 'high';
    if (!keep && !isReview(item)) stats.sentToReview += 1;
    return {
      ...item,
      crossCheck: 'type_conflict',
      ...(keep ? {} : { matchConfidence: 'low' as const }),
      evidence: note(item, `Second vision model (${options.model}) read this as ${otherLabel}${keep ? '' : ' — review'}`),
    };
  });

  // Only with a legend is there a review lane that keeps these out of the totals.
  second.forEach((other, s) => {
    if (sUsed.has(s) || other.locationMissing) return;
    if (!options.hasLegend) {
      stats.secondOnly += 1;
      return;
    }
    stats.secondOnly += 1;
    items.push({
      ...other,
      id: `xcheck_${other.id || s}`,
      crossCheck: 'second_only',
      confidence: Math.min(other.confidence ?? 0.45, 0.45),
      matchConfidence: 'low',
      evidence: note(other, `Found only by the second vision model (${options.model}) — review`),
    });
  });

  return { items, stats };
}

export function describeCrossCheck(stats: CrossCheckStats, hasLegend: boolean): string {
  const parts = [
    `Second vision model (${stats.model}) re-read the tiles: ${stats.agreed} detection(s) confirmed by both models`,
    `${stats.primaryOnly} seen only by the main model`,
    `${stats.typeConflicts} read as a different type`,
    hasLegend
      ? `${stats.secondOnly} extra found only by the second model (added as review markers)`
      : `${stats.secondOnly} extra seen only by the second model (not added — no legend on this sheet to type them)`,
  ];
  return `${parts.join(', ')}${stats.sentToReview ? `; ${stats.sentToReview} sent to review` : ''}.`;
}
