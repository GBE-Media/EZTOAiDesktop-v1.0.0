export type CountToolTotals = {
  total: number;
  matchingTypeCounts?: Record<string, number>;
  excludedByZone?: Array<{ zoneLabel: string; kind: string; count: number }>;
  message?: string;
};

type HistoryLike = Array<{ toolId?: string; result?: { output?: unknown }; output?: unknown }>;

function readCount(entry: HistoryLike[number]): (CountToolTotals & { unresolved: number }) | null {
  if (entry.toolId !== 'count_page_items') return null;
  const output = (entry.result && 'output' in entry.result ? entry.result.output : entry.output) as Record<string, unknown> | undefined;
  if (!output || typeof output !== 'object' || typeof output.total !== 'number') return null;
  const n = (value: unknown) => (typeof value === 'number' ? value : 0);
  return {
    total: output.total,
    matchingTypeCounts: isNumberRecord(output.matchingTypeCounts) ? output.matchingTypeCounts : undefined,
    excludedByZone: Array.isArray(output.excludedByZone)
      ? output.excludedByZone as CountToolTotals['excludedByZone']
      : undefined,
    message: typeof output.message === 'string' ? output.message : undefined,
    unresolved: n(output.unresolvedReturned) + n(output.unresolvedOmitted),
  };
}

export function lastCountPageItemsResult(toolHistory: HistoryLike): CountToolTotals | null {
  for (let i = toolHistory.length - 1; i >= 0; i -= 1) {
    const count = readCount(toolHistory[i]);
    if (count) {
      const { unresolved: _unresolved, ...rest } = count;
      return rest;
    }
  }
  return null;
}

/** Every count_page_items result in the run (multi-sheet takeoffs call it once per sheet). */
export function allCountPageItemsResults(toolHistory: HistoryLike): Array<CountToolTotals & { unresolved: number }> {
  return toolHistory.map(readCount).filter((row): row is CountToolTotals & { unresolved: number } => !!row);
}

/**
 * Check the headline count in the answer against count_page_items. Numbers the tool produced
 * (per sheet, per type, excluded, unresolved, and their sums across sheets) are allowed; page /
 * sheet numbers are ignored. On a mismatch the written answer is kept and a correction is added —
 * the answer is never replaced with raw tool output.
 */
export function groundAnswerToCountTool(
  draft: string,
  count: CountToolTotals,
  allCounts: Array<CountToolTotals & { unresolved?: number }> = [count],
): {
  message: string;
  revised: boolean;
  issues: string[];
} {
  const counts: Array<CountToolTotals & { unresolved?: number }> = allCounts.length ? allCounts : [count];
  const allowed = new Set<number>();
  const typeTotals = new Map<string, number>();
  let grand = 0;
  let unresolvedGrand = 0;
  for (const row of counts) {
    allowed.add(row.total);
    grand += row.total;
    unresolvedGrand += row.unresolved || 0;
    if (row.unresolved) allowed.add(row.unresolved);
    allowed.add(row.total + (row.unresolved || 0));
    for (const [type, value] of Object.entries(row.matchingTypeCounts || {})) {
      allowed.add(value);
      typeTotals.set(type, (typeTotals.get(type) || 0) + value);
    }
    for (const zone of row.excludedByZone || []) allowed.add(zone.count);
  }
  allowed.add(grand);
  allowed.add(unresolvedGrand);
  allowed.add(grand + unresolvedGrand);
  for (const value of typeTotals.values()) allowed.add(value);
  const claimed = claimedCount(draft);
  const issues: string[] = [];
  if (claimed != null && !allowed.has(claimed)) {
    issues.push(`Answer claimed ${claimed} but count_page_items total is ${counts.length > 1 ? grand : count.total}`);
  }
  if (!issues.length) return { message: draft, revised: false, issues };
  const correct = counts.length > 1 ? grand : count.total;
  const pattern = new RegExp(`(^|[^\\d,.])${String(claimed).replace(/\B(?=(\d{3})+(?!\d))/g, ',?')}(?![\\d,.]*\\d)`, 'g');
  const message = draft.replace(pattern, (_m, lead: string) => `${lead}${correct}`);
  return { message, revised: true, issues };
}

/** Strip page / sheet / scale / percentage numbers so they aren't mistaken for counts. */
function stripNonCountNumbers(text: string): string {
  return text
    .replace(/\b(pages?|pg\.?|p\.|sheets?|detail|section|rev(ision)?|scale|panel|circuit|ckt|item ids?)\s*#?\s*\d[\d,.\-–/ ]*/gi, ' ')
    .replace(/\b[A-Z]{1,3}-?\d+(\.\d+)?[A-Z]?\b/g, ' ')
    .replace(/\d+(\.\d+)?\s*(%|percent|ft|feet|'|"|in\b|v\b|volts?|a\b|amps?|w\b|watts?|k\b)/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
}

function claimedCount(draft: string): number | null {
  const text = stripNonCountNumbers(draft.replace(/\*\*/g, ''));
  const match = text.match(/(?:counted|found|total(?: of)?)\D{0,16}?(\d[\d,]*)/i)
    || text.match(/(\d[\d,]*)\s+(?:lighting\s+)?(?:symbols?|fixtures?|items?|lights?|luminaires?)\b/i);
  if (match) return Number(match[1].replace(/,/g, ''));
  return null;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every(entry => typeof entry === 'number');
}
