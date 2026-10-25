/**
 * Guided next steps after a command finishes: count → offer to place markers → offer suggested runs.
 * Deterministic (from tool results), so the follow-up appears even when the answer text doesn't ask.
 */
import type { FollowUpOffer } from './followUpOffer';

type HistoryEntry = { toolId?: string; args?: unknown; result?: { status?: string; output?: unknown } };

type CountOutput = {
  total?: number;
  page?: number;
  unresolvedReturned?: number;
  unresolvedOmitted?: number;
  analysisRef?: { page?: number };
};

const ELECTRICAL_RE = /\b(light|lighting|fixture|luminaire|receptacle|device|outlet|switch|exit|emergency|electrical)\b/i;

function lastEntry(history: HistoryEntry[], toolId: string): HistoryEntry | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) if (history[i].toolId === toolId) return history[i];
  return undefined;
}

const RUNS_REQUEST_RE = /\b(home ?runs?|branch circuits?|conduit|runs?\b.*\b(suggest|lay ?out|route)|suggest(ed)? runs?|wiring)\b/i;

export interface OfferAfterCountContext {
  /** The user's request this turn — no "place markers?" card when they asked for something else (e.g. runs). */
  request?: string;
  /** AI count markers already on that page (from an earlier turn) — don't offer to place them again. */
  aiMarkersOnPage?: (page: number | undefined) => number;
}

/** After counting (and nothing placed yet): "Place these on the drawing?" */
export function offerAfterCount(history: HistoryEntry[], context: OfferAfterCountContext = {}): FollowUpOffer | null {
  if (context.request && RUNS_REQUEST_RE.test(context.request)) return null;
  if (history.some(entry => entry.toolId === 'suggest_runs')) return null;
  const count = lastEntry(history, 'count_page_items');
  if (!count || count.result?.status !== 'completed') return null;
  const output = (count.result.output || {}) as CountOutput;
  const total = typeof output.total === 'number' ? output.total : 0;
  if (total <= 0) return null;
  const countIndex = history.lastIndexOf(count);
  const placedAfter = history.slice(countIndex + 1).some(entry => entry.toolId === 'place_markups' || entry.toolId === 'suggest_runs');
  if (placedAfter) return null;
  const args = (count.args || {}) as { page?: number; query?: string };
  const page = args.page || output.analysisRef?.page || output.page;
  if (context.aiMarkersOnPage && context.aiMarkersOnPage(page) > 0) return null;
  const unresolved = (output.unresolvedReturned || 0) + (output.unresolvedOmitted || 0);
  const where = page ? ` on page ${page}` : '';
  const options: FollowUpOffer['options'] = [
    { label: 'Place count markers', reply: `Place the ${total} counted items${where} as count markers.`, primary: true },
  ];
  if (unresolved > 0) {
    options.push({
      label: `Also mark ${unresolved} to review`,
      reply: `Place the ${total} counted items${where} as count markers, plus review markers for the ${unresolved} unresolved symbols.`,
    });
  }
  options.push({ label: 'Not now', reply: null });
  return {
    question: `Place the ${total} counted items${where} on the drawing?`,
    options,
  };
}

/** After count markers are placed: "Suggest conduit runs?" (electrical counts only). */
export function offerAfterPlacement(options: {
  approvalToolId: string;
  placed?: number;
  page?: number;
  history?: HistoryEntry[];
  trade?: string;
}): FollowUpOffer | null {
  if (options.approvalToolId !== 'place_markups' || !options.placed || options.placed <= 0) return null;
  const count = options.history ? lastEntry(options.history, 'count_page_items') : undefined;
  const query = String(((count?.args || {}) as { query?: string }).query || '');
  const electrical = options.trade === 'electrical' || ELECTRICAL_RE.test(query);
  if (!electrical) return null;
  const where = options.page ? ` on page ${options.page}` : '';
  return {
    question: `Want me to lay out suggested conduit runs for these${where}?`,
    options: [
      {
        label: 'Suggest runs',
        reply: `Suggest home runs and branch circuits for the counted fixtures${where}.`,
        primary: true,
      },
      { label: 'Not now', reply: null },
    ],
  };
}
