export type CountToolTotals = {
  total: number;
  matchingTypeCounts?: Record<string, number>;
  excludedByZone?: Array<{ zoneLabel: string; kind: string; count: number }>;
  message?: string;
};

export function lastCountPageItemsResult(
  toolHistory: Array<{ toolId?: string; result?: { output?: unknown }; output?: unknown }>,
): CountToolTotals | null {
  for (let i = toolHistory.length - 1; i >= 0; i -= 1) {
    const entry = toolHistory[i];
    if (entry.toolId !== 'count_page_items') continue;
    const output = (entry.result && 'output' in entry.result ? entry.result.output : entry.output) as Record<string, unknown> | undefined;
    if (!output || typeof output !== 'object') continue;
    if (typeof output.total !== 'number') continue;
    return {
      total: output.total,
      matchingTypeCounts: isNumberRecord(output.matchingTypeCounts) ? output.matchingTypeCounts : undefined,
      excludedByZone: Array.isArray(output.excludedByZone)
        ? output.excludedByZone as CountToolTotals['excludedByZone']
        : undefined,
      message: typeof output.message === 'string' ? output.message : undefined,
    };
  }
  return null;
}

export function groundAnswerToCountTool(draft: string, count: CountToolTotals): {
  message: string;
  revised: boolean;
  issues: string[];
} {
  const allowed = new Set<number>([count.total]);
  for (const value of Object.values(count.matchingTypeCounts || {})) allowed.add(value);
  for (const row of count.excludedByZone || []) allowed.add(row.count);
  const claimed = claimedCount(draft);
  const issues: string[] = [];
  if (claimed != null && claimed !== count.total && !allowed.has(claimed)) {
    issues.push(`Answer claimed ${claimed} but count_page_items total is ${count.total}`);
  }
  if (!issues.length) return { message: draft, revised: false, issues };
  const excluded = (count.excludedByZone || [])
    .map(row => `${row.count} in the ${row.zoneLabel}`)
    .join(' and ');
  const typeBits = Object.entries(count.matchingTypeCounts || {})
    .map(([type, n]) => `${type}: ${n}`)
    .join(', ');
  const revised = [
    count.message || `Counted ${count.total} item(s).`,
    typeBits ? `By type: ${typeBits}.` : '',
    excluded ? `Excluded ${excluded}.` : '',
  ].filter(Boolean).join(' ');
  return { message: revised, revised: true, issues };
}

function claimedCount(draft: string): number | null {
  const match = draft.match(/(?:counted|count(?:ed)?(?: of)?|found|total(?: of)?|symbols?|fixtures?|items?)\D{0,12}(\d+)/i)
    || draft.match(/(\d+)\s+(?:symbols?|fixtures?|items?|lights?)/i);
  if (match) return Number(match[1]);
  const nums = [...draft.matchAll(/\b(\d{1,4})\b/g)].map(row => Number(row[1])).filter(n => n > 1);
  if (nums.length === 1) return nums[0];
  return null;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every(entry => typeof entry === 'number');
}
