import type { DetectedItem } from '../providers/types';
import type { LegendAwareCountResult, LegendEntry } from './legendAwareCounting';
import { formatLegendPromptBlock } from './legendAwareCounting';

/** Sentinel: model could not confidently map a detection to a page legend code. */
export const NO_CONFIDENT_MATCH = 'no_confident_match';

export type MatchConfidence = 'high' | 'medium' | 'low';

/**
 * Build the vision prompt block: page legend codes + classification instructions.
 * Injected into overview/detail passes BEFORE detection (not post-hoc remapping).
 */
export function buildLegendClassificationPrompt(legend: LegendEntry[]): string {
  if (legend.length === 0) return '';
  const allowed = [...legend.map((e) => e.typeCode), NO_CONFIDENT_MATCH];
  return [
    formatLegendPromptBlock(legend),
    '',
    'LEGEND CLASSIFICATION (required for every detected fixture/symbol):',
    '- For each detection, set legendTypeCode to EXACTLY one value from this allowed list:',
    `  ${allowed.map((c) => `"${c}"`).join(' | ')}`,
    '- If this legend has multiple variants of a base type (e.g. a plain code and one or more',
    '  suffixed/modified variants), look for the specific visual marker, adjacent text, or',
    '  symbol modification that distinguishes them, and pick the specific variant only if you',
    '  can identify that distinguishing evidence — otherwise use the base code.',
    `- If you cannot confidently match a detected symbol to any code on this list, return "${NO_CONFIDENT_MATCH}" rather than guessing.`,
    '- Also set matchConfidence to "high" | "medium" | "low" and matchReasoning to a short',
    '  explanation of why you chose that code (or why you returned no_confident_match).',
    '- Never invent type codes that are not on the allowed list.',
    '- Never count legend/schedule rows as installed quantities.',
  ].join('\n');
}

/** True when the model returned structured legend classification fields on any item. */
export function itemsHaveVisionLegendFields(items: DetectedItem[]): boolean {
  return items.some((item) => typeof item.legendTypeCode === 'string' && item.legendTypeCode.length > 0);
}

/**
 * Strict allow-list check: page legend codes + no_confident_match only.
 * Rejects invented / hallucinated codes.
 */
export function validateLegendTypeCode(
  raw: string | undefined | null,
  legend: LegendEntry[],
): { ok: true; code: string } | { ok: false; reason: string } {
  if (raw == null || typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'Missing legendTypeCode' };
  }
  const code = raw.trim();
  if (code === NO_CONFIDENT_MATCH) {
    return { ok: true, code };
  }
  const allowed = new Set(legend.map((e) => e.typeCode));
  // Case-insensitive match against real legend codes, preserve canonical casing.
  for (const entry of legend) {
    if (entry.typeCode.toUpperCase() === code.toUpperCase()) {
      return { ok: true, code: entry.typeCode };
    }
  }
  if (!allowed.has(code)) {
    return {
      ok: false,
      reason: `legendTypeCode “${code}” is not in this page’s legend (and is not ${NO_CONFIDENT_MATCH})`,
    };
  }
  return { ok: true, code };
}

export function normalizeMatchConfidence(raw: unknown): MatchConfidence | undefined {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (typeof raw === 'string') {
    const v = raw.toLowerCase().trim();
    if (v === 'high' || v === 'medium' || v === 'low') return v;
  }
  return undefined;
}

/**
 * Primary path: consume vision-native legendTypeCode / matchConfidence / matchReasoning.
 * Invalid codes and low / no_confident_match items go to unresolved/ambiguous — not counted.
 */
export function applyVisionNativeLegendCounting(options: {
  items: DetectedItem[];
  legendEntries: LegendEntry[];
}): LegendAwareCountResult {
  const { items, legendEntries } = options;
  const unresolved: DetectedItem[] = [];
  const ambiguous: Array<{ item: DetectedItem; candidates: string[] }> = [];

  const remapped: DetectedItem[] = items.map((item) => {
    const validated = validateLegendTypeCode(item.legendTypeCode, legendEntries);
    const confidence = normalizeMatchConfidence(item.matchConfidence) || 'medium';
    const reasoning = typeof item.matchReasoning === 'string' ? item.matchReasoning.trim() : '';

    if (validated.ok === false) {
      const invalidReason = validated.reason;
      unresolved.push(item);
      return {
        ...item,
        legendTypeCode: item.legendTypeCode,
        matchConfidence: confidence,
        matchReasoning: reasoning || invalidReason,
        notes: [item.notes, `Invalid vision legendTypeCode: ${invalidReason}`]
          .filter(Boolean)
          .join(' — '),
        confidence: Math.min(item.confidence, 0.4),
      };
    }

    if (validated.code === NO_CONFIDENT_MATCH) {
      unresolved.push(item);
      return {
        ...item,
        type: item.type,
        legendTypeCode: NO_CONFIDENT_MATCH,
        matchConfidence: confidence,
        matchReasoning: reasoning || 'Model returned no_confident_match',
        notes: [item.notes, 'Vision: no_confident_match for legend type']
          .filter(Boolean)
          .join(' — '),
        confidence: Math.min(item.confidence, 0.5),
      };
    }

    if (confidence === 'low') {
      ambiguous.push({
        item,
        candidates: [validated.code],
      });
      return {
        ...item,
        type: validated.code,
        legendTypeCode: validated.code,
        matchConfidence: 'low',
        matchReasoning: reasoning,
        notes: [item.notes, `Low-confidence legend match: ${validated.code}${reasoning ? ` — ${reasoning}` : ''}`]
          .filter(Boolean)
          .join(' — '),
        confidence: Math.min(item.confidence, 0.45),
      };
    }

    return {
      ...item,
      type: validated.code,
      name: item.name && item.name !== item.type ? item.name : validated.code,
      legendTypeCode: validated.code,
      matchConfidence: confidence,
      matchReasoning: reasoning,
      evidence: [
        item.evidence,
        `Vision legendTypeCode=${validated.code} (${confidence})${reasoning ? `: ${reasoning}` : ''}`,
      ].filter(Boolean).join('; '),
    };
  });

  const counted = remapped.filter((item) => {
    if (item.legendTypeCode === NO_CONFIDENT_MATCH) return false;
    if (item.matchConfidence === 'low') return false;
    if (!legendEntries.some((e) => e.typeCode === item.type)) return false;
    // Exclude items flagged unresolved (invalid codes keep original type)
    if (unresolved.some((u) => u.id === item.id)) return false;
    return true;
  });

  const typeCounts: Record<string, number> = {};
  for (const item of counted) {
    typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
  }

  const legendTypeCounts: Record<string, number> = {};
  for (const entry of legendEntries) {
    legendTypeCounts[entry.typeCode] = typeCounts[entry.typeCode] || 0;
  }

  const resolvedCount = counted.length;
  const legendMatchRate = remapped.length === 0 ? 0 : resolvedCount / remapped.length;

  let reliability: LegendAwareCountResult['reliability'] = 'low';
  if (legendEntries.length === 0) {
    reliability = 'low';
  } else if (legendMatchRate >= 0.85 && ambiguous.length === 0 && unresolved.length === 0) {
    reliability = 'high';
  } else if (legendMatchRate >= 0.5) {
    reliability = 'partial';
  }

  const notes: string[] = [];
  notes.push(
    `Vision-native legend classification using ${legendEntries.length} type code(s): `
    + legendEntries.map((e) => e.typeCode).join(', '),
  );
  if (ambiguous.length > 0) {
    notes.push(
      `${ambiguous.length} detection(s) marked low-confidence by the vision model — not counted in totals.`,
    );
  }
  if (unresolved.length > 0) {
    notes.push(
      `${unresolved.length} detection(s) unresolved (no_confident_match or invalid legendTypeCode).`,
    );
  }
  if (reliability !== 'high') {
    notes.push(
      `Reliability: ${reliability}. Do not present per-type counts as final without review of flagged items.`,
    );
  }

  return {
    items: remapped,
    typeCounts: Object.keys(typeCounts).length > 0 ? typeCounts : {},
    legendTypeCounts,
    unresolved,
    ambiguous,
    reliability,
    legendEntries,
    verification: {
      notes,
      resolvedCount,
      unresolvedCount: unresolved.length,
      ambiguousCount: ambiguous.length,
      legendMatchRate,
    },
  };
}

/**
 * Choose primary (vision-native) vs secondary (token-overlap) legend counting.
 * Secondary runs only when structured legend fields are entirely absent.
 */
export function resolveLegendAwareCounting(options: {
  items: DetectedItem[];
  legendEntries: LegendEntry[];
  trade?: import('../providers/types').TradeType;
  applyTokenOverlapFallback: (opts: {
    items: DetectedItem[];
    legendEntries: LegendEntry[];
    trade?: import('../providers/types').TradeType;
  }) => LegendAwareCountResult;
}): LegendAwareCountResult & { path: 'vision-native' | 'token-overlap-fallback' | 'no-legend' } {
  const { items, legendEntries, trade, applyTokenOverlapFallback } = options;
  if (legendEntries.length === 0) {
    const empty = applyTokenOverlapFallback({ items, legendEntries, trade });
    return { ...empty, path: 'no-legend' };
  }
  if (itemsHaveVisionLegendFields(items)) {
    return { ...applyVisionNativeLegendCounting({ items, legendEntries }), path: 'vision-native' };
  }
  return {
    ...applyTokenOverlapFallback({ items, legendEntries, trade }),
    path: 'token-overlap-fallback',
  };
}
