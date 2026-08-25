import type { DetectedItem, TradeType } from '../providers/types';

/**
 * Legend-aware fixture counting.
 *
 * Electrical plans encode ground truth in a page legend/schedule
 * (TYPE A, B-NL, EX1, …). Matching detections against THAT vocabulary
 * is far more reliable than generic OCR-label proximity or free-form
 * vision labels like "recessed light" / "night light".
 */

export type LegendEntry = {
  typeCode: string;
  description: string;
  source: 'legend' | 'schedule' | 'text';
};

export type LegendMatchKind = 'exact' | 'token' | 'none' | 'ambiguous';

export type LegendNormalizeResult = {
  typeCode: string | null;
  matchKind: LegendMatchKind;
  candidates: string[];
};

export type LegendAwareCountResult = {
  items: DetectedItem[];
  typeCounts: Record<string, number>;
  /** Expected types from the legend with zero detections (still listed). */
  legendTypeCounts: Record<string, number>;
  unresolved: DetectedItem[];
  ambiguous: Array<{ item: DetectedItem; candidates: string[] }>;
  reliability: 'high' | 'partial' | 'low';
  legendEntries: LegendEntry[];
  verification: {
    notes: string[];
    resolvedCount: number;
    unresolvedCount: number;
    ambiguousCount: number;
    /** Fraction of detections mapped to a legend type code. */
    legendMatchRate: number;
  };
};

/** Fixture-type codes seen on electrical legends (A, B1, B-NL, A/EM/NL, EX1, LT/FN, …). */
const TYPE_CODE_PATTERN =
  /\b(?:TYPE\s+)?([A-Z]{1,3}\d*(?:[/-][A-Z0-9]+)*)\b/g;

const LEGEND_SECTION_RE =
  /\b(LIGHTING\s+FIXTURE\s+SCHEDULE|FIXTURE\s+SCHEDULE|SYMBOL\s+LEGEND|LIGHTING\s+LEGEND|LEGEND|SCHEDULE)\b/i;

const NOISE_CODES = new Set([
  'TYPE', 'LED', 'NEC', 'PDF', 'DWG', 'REV', 'SHEET', 'SCALE', 'DATE',
  'DRAWING', 'PLAN', 'FLOOR', 'ROOM', 'NOTE', 'NOTES', 'SEE', 'PER',
  'AND', 'THE', 'FOR', 'WITH', 'FROM', 'TO', 'OF', 'IN', 'ON',
]);

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function isPlausibleTypeCode(code: string): boolean {
  if (!code || code.length > 12) return false;
  if (NOISE_CODES.has(code)) return false;
  // Require at least one letter; allow digits and / -
  if (!/^[A-Z]{1,3}\d*(?:[/-][A-Z0-9]+)*$/.test(code)) return false;
  // Pure single letters A–Z are OK (fixture types); reject very generic 2+ letter words without digits/separators unless short
  if (/^[A-Z]{3,}$/.test(code) && !/\d|[/-]/.test(code)) {
    // Allow common short fixture codes like EX, EM, ER, NL when they appear as standalone legend rows
    return code.length <= 3;
  }
  return true;
}

/**
 * Parse legend/schedule rows from page text lines.
 * Prefers lines near a LEGEND/SCHEDULE header; also accepts "TYPE A - …" anywhere.
 */
export function parseLegendFromTextLines(lines: string[]): LegendEntry[] {
  const entries = new Map<string, LegendEntry>();
  let inSection = false;
  let sectionLinesRemaining = 0;

  const add = (code: string, description: string, source: LegendEntry['source']) => {
    const typeCode = normalizeCode(code);
    if (!isPlausibleTypeCode(typeCode)) return;
    if (entries.has(typeCode)) return;
    entries.set(typeCode, {
      typeCode,
      description: description.trim(),
      source,
    });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (LEGEND_SECTION_RE.test(line)) {
      inSection = true;
      sectionLinesRemaining = 40;
      // Header itself may include "TYPE A" — still scan
    }

    const typePrefixed = line.match(
      /^\s*(?:TYPE\s+)?([A-Z]{1,3}\d*(?:[/-][A-Z0-9]+)*)\s*[-–—:.)]\s*(.+)$/i,
    );
    if (typePrefixed) {
      add(typePrefixed[1], typePrefixed[2], inSection ? 'legend' : 'schedule');
      continue;
    }

    // Schedule-style: "A    2x4 RECESSED LED" (code then spaces then description)
    const spaced = line.match(
      /^\s*(?:TYPE\s+)?([A-Z]{1,3}\d*(?:[/-][A-Z0-9]+)*)\s{2,}(.+)$/i,
    );
    if (spaced && (inSection || sectionLinesRemaining > 0)) {
      add(spaced[1], spaced[2], 'schedule');
      continue;
    }

    if (inSection || sectionLinesRemaining > 0) {
      TYPE_CODE_PATTERN.lastIndex = 0;
      const matches = [...line.matchAll(TYPE_CODE_PATTERN)];
      for (const match of matches) {
        const code = match[1];
        if (!code || /^TYPE$/i.test(code)) continue;
        const after = line.slice((match.index || 0) + match[0].length).trim();
        add(code, after || line, 'legend');
      }
      sectionLinesRemaining -= 1;
      if (sectionLinesRemaining <= 0) inSection = false;
    }
  }

  return [...entries.values()].sort((a, b) => b.typeCode.length - a.typeCode.length || a.typeCode.localeCompare(b.typeCode));
}

/** Sort codes longest-first so B-NL wins over B, A/EM/NL over A. */
export function sortTypeCodesSpecificFirst(codes: string[]): string[] {
  return [...codes].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Description overlap must be a real majority with ≥2 tokens — never a single incidental word. */
function descriptionMatchQualifies(matchedCount: number, descTokenCount: number): boolean {
  if (descTokenCount <= 0 || matchedCount < 2) return false;
  return matchedCount / descTokenCount > 0.5;
}

/**
 * Map a free-form vision label onto the page's own legend type codes.
 * Never invents a type code that is not in the legend.
 */
export function normalizeTypeAgainstLegend(
  rawType: string,
  rawName: string,
  legend: LegendEntry[],
): LegendNormalizeResult {
  if (legend.length === 0) {
    return { typeCode: null, matchKind: 'none', candidates: [] };
  }

  const codes = sortTypeCodesSpecificFirst(legend.map((e) => e.typeCode));
  const hay = `${rawType || ''} ${rawName || ''}`.toUpperCase().replace(/\s+/g, ' ').trim();
  const hayCompact = hay.replace(/\s+/g, '');
  const t = normalizeCode(rawType || '');
  const n = normalizeCode(rawName || '');

  type Hit = { code: string; score: number; via: 'exact' | 'token' | 'description' };
  const hits: Hit[] = [];

  for (const code of codes) {
    if (t === code || n === code) {
      hits.push({ code, score: 10 + code.length / 100, via: 'exact' });
    }
  }

  for (const code of codes) {
    const codeCompact = code.replace(/\s+/g, '');
    const escaped = codeCompact.replace(/[/-]/g, (ch) => `\\${ch}`);
    const tokenRe = new RegExp(`(?:^|[^A-Z0-9])${escaped}(?:[^A-Z0-9]|$)`);
    if (tokenRe.test(hayCompact) || tokenRe.test(hay.replace(/\s+/g, ''))) {
      if (!hits.some((h) => h.code === code && h.via === 'exact')) {
        hits.push({ code, score: 5 + code.length / 100, via: 'token' });
      }
    }

    const entry = legend.find((e) => e.typeCode === code);
    if (!entry?.description) continue;
    const descTokens = entry.description
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((tok) => tok.length >= 4);
    const hayTokens = new Set(hay.split(/[^A-Z0-9]+/).filter(Boolean));
    const matched = descTokens.filter((tok) => hayTokens.has(tok));
    if (!descriptionMatchQualifies(matched.length, descTokens.length)) continue;
    const ratio = matched.length / descTokens.length;
    const score = 3 + matched.length + ratio + code.length / 100;
    const existing = hits.find((h) => h.code === code);
    if (existing) {
      existing.score = Math.max(existing.score, score);
    } else {
      hits.push({ code, score, via: 'description' });
    }
  }

  // Demote a generic exact match only when a more-specific sibling has STRONG
  // evidence (token/exact on the sibling code, or a qualified description majority).
  // Pure code-string containment (B ⊂ B1) + weak description must NOT demote.
  for (const hit of hits) {
    if (hit.via !== 'exact') continue;
    for (const other of hits) {
      if (other.code === hit.code) continue;
      if (!other.code.includes(hit.code)) continue;
      const strongSibling =
        other.via === 'token'
        || other.via === 'exact'
        || other.via === 'description'; // description hits already require ≥2 tokens + majority
      if (strongSibling) {
        hit.score = Math.min(hit.score, 4);
      }
    }
  }

  if (hits.length === 0) {
    return { typeCode: null, matchKind: 'none', candidates: [] };
  }

  hits.sort((a, b) => b.score - a.score || b.code.length - a.code.length);
  const best = hits[0];

  const strong = hits.filter((h) => {
    if (h.code === best.code) return true;
    if (best.code.includes(h.code) || h.code.includes(best.code)) {
      return h.score >= best.score - 0.05;
    }
    return h.score >= best.score - 0.15;
  });

  const rivalCodes = strong.map((h) => h.code).filter((c) => c !== best.code);
  if (rivalCodes.length > 0 && strong[1] && strong[1].score >= best.score - 0.15) {
    const unrelated = rivalCodes.filter(
      (c) => !best.code.includes(c) && !c.includes(best.code),
    );
    if (unrelated.length > 0 && Math.abs(strong[1].score - best.score) < 0.35) {
      return {
        typeCode: null,
        matchKind: 'ambiguous',
        candidates: [best.code, ...unrelated].slice(0, 4),
      };
    }
  }

  return {
    typeCode: best.code,
    matchKind: best.via === 'exact' ? 'exact' : 'token',
    candidates: [best.code],
  };
}

function countsFromItems(items: DetectedItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = item.type || item.name || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

/**
 * Remap detections onto the page legend, rebuild typeCounts, and produce
 * an honest reliability / verification report.
 */
export function applyLegendAwareCounting(options: {
  items: DetectedItem[];
  legendEntries: LegendEntry[];
  trade?: TradeType;
}): LegendAwareCountResult {
  const { items, legendEntries } = options;
  const unresolved: DetectedItem[] = [];
  const ambiguous: Array<{ item: DetectedItem; candidates: string[] }> = [];

  const remapped: DetectedItem[] = items.map((item) => {
    const result = normalizeTypeAgainstLegend(item.type, item.name, legendEntries);
    if (result.matchKind === 'ambiguous') {
      ambiguous.push({ item, candidates: result.candidates });
      return {
        ...item,
        notes: [item.notes, `Ambiguous legend match: ${result.candidates.join(' | ')}`]
          .filter(Boolean)
          .join(' — '),
        confidence: Math.min(item.confidence, 0.45),
      };
    }
    if (!result.typeCode) {
      unresolved.push(item);
      return {
        ...item,
        notes: [item.notes, 'No matching legend type for this detection']
          .filter(Boolean)
          .join(' — '),
        confidence: Math.min(item.confidence, 0.55),
      };
    }
    return {
      ...item,
      type: result.typeCode,
      name: item.name && item.name !== item.type ? item.name : result.typeCode,
      evidence: [item.evidence, `Legend type ${result.typeCode} (${result.matchKind})`]
        .filter(Boolean)
        .join('; '),
    };
  });

  const typeCounts = countsFromItems(
    remapped.filter((item) => legendEntries.some((e) => e.typeCode === item.type)),
  );

  // Include zero-count legend types so callers see the full type set
  const legendTypeCounts: Record<string, number> = {};
  for (const entry of legendEntries) {
    legendTypeCounts[entry.typeCode] = typeCounts[entry.typeCode] || 0;
  }

  const resolvedCount = remapped.length - unresolved.length - ambiguous.length;
  const legendMatchRate = remapped.length === 0
    ? 0
    : resolvedCount / remapped.length;

  let reliability: LegendAwareCountResult['reliability'] = 'low';
  if (legendEntries.length === 0) {
    reliability = 'low';
  } else if (legendMatchRate >= 0.85 && ambiguous.length === 0) {
    reliability = 'high';
  } else if (legendMatchRate >= 0.5) {
    reliability = 'partial';
  }

  const notes: string[] = [];
  if (legendEntries.length === 0) {
    notes.push(
      'No page legend/schedule type codes extracted — counts are not legend-grounded. Treat as provisional.',
    );
  } else {
    notes.push(
      `Legend-grounded using ${legendEntries.length} type code(s) from this page: `
      + legendEntries.map((e) => e.typeCode).join(', '),
    );
  }
  if (ambiguous.length > 0) {
    notes.push(
      `${ambiguous.length} detection(s) ambiguous between legend types `
      + `(e.g. ${ambiguous[0].candidates.join(' vs ')}) — not assigned a type.`,
    );
  }
  if (unresolved.length > 0) {
    notes.push(
      `${unresolved.length} detection(s) could not be matched to the page legend.`,
    );
  }
  if (reliability !== 'high') {
    notes.push(
      `Reliability: ${reliability}. Do not present per-type counts as final without review of flagged items.`,
    );
  }

  return {
    items: remapped,
    typeCounts: Object.keys(typeCounts).length > 0 ? typeCounts : countsFromItems(remapped),
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

/** Prompt fragment listing page legend codes for vision detail/overview passes. */
export function formatLegendPromptBlock(legend: LegendEntry[]): string {
  if (legend.length === 0) return '';
  const rows = legend
    .map((e) => `- ${e.typeCode}${e.description ? `: ${e.description}` : ''}`)
    .join('\n');
  return [
    'PAGE LEGEND / FIXTURE TYPE CODES (from this sheet — ground truth for typing):',
    rows,
    'Rules:',
    '- Set each detection item.type to the EXACT type code from this list (e.g. "B-NL", not "night light" or "B").',
    '- Prefer the most specific code when variants share a base shape (B-NL over B, A/EM/NL over A).',
    '- Never invent type codes that are not in this list.',
    '- Never count legend/schedule rows as installed quantities.',
  ].join('\n');
}

/** Raw typeCounts from detections with no legend remapping (baseline / fallback). */
export function rawTypeCountsFromItems(items: DetectedItem[]): Record<string, number> {
  return countsFromItems(items);
}
