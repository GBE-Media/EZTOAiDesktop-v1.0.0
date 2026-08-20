import type { ClarificationOption } from '@/types/assistant';

/** BidveraAi common clarification chips keyed by step / intent. */
export const BIDVERA_QUESTION_TEMPLATES: Record<string, ClarificationOption[]> = {
  estimate_type: [
    { id: 'rough', label: 'Rough estimate', value: 'rough' },
    { id: 'detailed', label: 'Detailed takeoff', value: 'detailed' },
    { id: 'budget', label: 'Budget only', value: 'budget' },
  ],
  optimize_for: [
    { id: 'speed', label: 'Speed', value: 'speed' },
    { id: 'accuracy', label: 'Accuracy', value: 'accuracy' },
    { id: 'cost', label: 'Lowest cost', value: 'cost' },
  ],
  apply_counts: [
    { id: 'apply_all', label: 'Apply all counts', value: 'apply_all' },
    { id: 'review_first', label: 'Review first', value: 'review_first' },
    { id: 'selected_only', label: 'Selected items only', value: 'selected_only' },
  ],
  scope: [
    { id: 'current_page', label: 'Current page', value: 'current_page' },
    { id: 'selected_pages', label: 'Selected pages', value: 'selected_pages' },
    { id: 'full_document', label: 'Full document', value: 'full_document' },
  ],
  placement: [
    { id: 'place_now', label: 'Place callouts now', value: 'place_now' },
    { id: 'preview_only', label: 'Preview only', value: 'preview_only' },
    { id: 'skip_placement', label: 'Skip placement', value: 'skip_placement' },
  ],
  trade_confirm: [
    { id: 'electrical', label: 'Electrical', value: 'electrical' },
    { id: 'mechanical', label: 'Mechanical', value: 'mechanical' },
    { id: 'plumbing', label: 'Plumbing', value: 'plumbing' },
    { id: 'other', label: 'Other', value: 'other' },
  ],
};

const KEYWORD_TO_STEP: Array<{ key: string; patterns: RegExp[] }> = [
  {
    key: 'estimate_type',
    patterns: [/estimate\s*type/i, /rough\s*(or|vs)/i, /detailed\s*takeoff/i, /budget/i],
  },
  {
    key: 'optimize_for',
    patterns: [/optimiz/i, /prefer\s*(speed|accuracy|cost)/i, /fast(er)?\s*or\s*accurat/i],
  },
  {
    key: 'apply_counts',
    patterns: [/apply\s*(the\s*)?counts?/i, /material\s*counts?/i, /use\s*these\s*counts?/i],
  },
  {
    key: 'scope',
    patterns: [/which\s*page/i, /current\s*page/i, /full\s*document/i, /selected\s*pages?/i, /scope/i],
  },
  {
    key: 'placement',
    patterns: [/place\s*callouts?/i, /place\s*markers?/i, /placement/i],
  },
  {
    key: 'trade_confirm',
    patterns: [/which\s*trade/i, /electrical|mechanical|plumbing/i],
  },
];

export function inferClarificationStepKey(question: string, explicit?: string): string {
  if (explicit && BIDVERA_QUESTION_TEMPLATES[explicit]) return explicit;
  for (const entry of KEYWORD_TO_STEP) {
    if (entry.patterns.some(pattern => pattern.test(question))) {
      return entry.key;
    }
  }
  return explicit || 'general';
}

export const MODEL_OPTION_ID_MAX = 64;
export const MODEL_OPTION_LABEL_MAX = 120;
export const MODEL_OPTION_VALUE_MAX = 200;

/**
 * Strict gate for model-supplied clarification chips.
 * Returns null when the set is missing or malformed so callers fall back to templates/freeform.
 * Does not coerce, derive, filter, or partially accept invalid entries.
 */
export function validateModelClarificationOptions(
  options: unknown,
): ClarificationOption[] | null {
  if (!Array.isArray(options)) return null;
  if (options.length < 2 || options.length > 6) return null;

  const normalized: ClarificationOption[] = [];
  const seenIds = new Set<string>();
  const seenValues = new Set<string>();

  for (const raw of options) {
    if (!isPlainObject(raw)) return null;

    const { id, label, value } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || typeof label !== 'string' || typeof value !== 'string') {
      return null;
    }

    // Enforce limits on the raw supplied strings before trim so padding cannot bypass them.
    if (id.length > MODEL_OPTION_ID_MAX) return null;
    if (label.length > MODEL_OPTION_LABEL_MAX) return null;
    if (value.length > MODEL_OPTION_VALUE_MAX) return null;

    const trimmedId = id.trim();
    const trimmedLabel = label.trim();
    const trimmedValue = value.trim();
    if (!trimmedId || !trimmedLabel || !trimmedValue) return null;
    if (seenIds.has(trimmedId) || seenValues.has(trimmedValue)) return null;

    seenIds.add(trimmedId);
    seenValues.add(trimmedValue);
    normalized.push({
      id: trimmedId,
      label: trimmedLabel,
      value: trimmedValue,
    });
  }

  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve clickable options for a clarification. Returns [] for freeform-only cards.
 * Precedence: validated model options → keyword templates → empty (freeform).
 */
export function resolveClarificationOptions(
  question: string,
  options?: ClarificationOption[] | unknown,
  stepKey?: string,
): ClarificationOption[] {
  const modelOptions = validateModelClarificationOptions(options);
  if (modelOptions) return modelOptions;

  const key = inferClarificationStepKey(question, stepKey);
  return (BIDVERA_QUESTION_TEMPLATES[key] || []).slice(0, 6);
}
