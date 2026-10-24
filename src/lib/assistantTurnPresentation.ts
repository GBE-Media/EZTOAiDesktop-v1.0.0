import type { AssistantMessageBlock, AssistantRun, ToolActivity } from '@/types/assistant';

export const FRIENDLY_TOOL_LABELS: Record<string, string> = {
  count_page_items: 'Counted fixtures',
  place_markups: 'Placed markups',
  analyze_page: 'Read the page',
  search_catalog: 'Searched products',
  get_takeoff_summary: 'Checked the takeoff',
};

const PROCESS_BLOCK_TYPES = new Set(['activity', 'progress', 'tool-result']);
const RAW_TOOL_ID_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const ROLE_CHIP_RE = /\b(PLACEMENT|VISION|ESTIMATE)\b/;
const STEP_COUNTER_RE = /\b\d+\s*\/\s*\d+\b/;

const PROCESS_TYPES = ['activity', 'progress', 'tool-result'] as const;

export function looksLikeToolId(text: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(text.trim());
}

/** Map an internal tool id to a friendly label. Unknown ids become Title Case words. */
export function friendlyToolLabel(toolId: string): string {
  const id = String(toolId || '').trim();
  if (!id) return 'Worked';
  if (FRIENDLY_TOOL_LABELS[id]) return FRIENDLY_TOOL_LABELS[id];
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function toProgressive(label: string): string {
  return label
    .replace(/^Counted\b/i, 'Counting')
    .replace(/^Placed\b/i, 'Placing')
    .replace(/^Read\b/i, 'Reading')
    .replace(/^Searched\b/i, 'Searching')
    .replace(/^Checked\b/i, 'Checking');
}

/** Plain verb phrase for a tool, used in "Couldn't <verb>" sentences. */
const TOOL_VERBS: Record<string, string> = {
  count_page_items: 'count fixtures',
  place_markups: 'place markups',
  analyze_page: 'read the page',
  search_catalog: 'search products',
  get_takeoff_summary: 'check the takeoff',
};

export function toolVerb(toolId?: string): string {
  const id = String(toolId || '').trim();
  return (id && TOOL_VERBS[id]) || 'finish that step';
}

/** Status shown while a turn is running (no tool ids, counters, or role chips). */
export function friendlyStatusLine(raw: string | undefined | null): string {
  const text = String(raw || '').trim();
  if (!text) return 'Working';
  const running = text.match(/^Running\s+(\S+)/i);
  if (running?.[1]) {
    return toProgressive(friendlyToolLabel(running[1].replace(/[.,;:]+$/, '')));
  }
  if (looksLikeToolId(text)) {
    return toProgressive(friendlyToolLabel(text));
  }
  return text
    .replace(STEP_COUNTER_RE, '')
    .replace(ROLE_CHIP_RE, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[;:]\s*$/g, '')
    .trim() || 'Working';
}

export function humanizeToolError(raw: string, toolId?: string): string {
  const action = toProgressive(toolId ? friendlyToolLabel(toolId) : 'That step').toLowerCase();
  const lower = String(raw || '').toLowerCase();
  if (lower.includes('retry')) {
    return `Couldn't ${toolVerb(toolId)} on the first try, retrying...`;
  }
  if (lower.includes('too_big') || lower.includes('too large') || lower.includes('"maximum"') || lower.includes('maximum')) {
    return `${action.charAt(0).toUpperCase()}${action.slice(1)} failed: the request was too large.`;
  }
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} failed.`;
}

export function formatWorkedSummary(stepCount: number, durationMs?: number): string {
  const steps = `${Math.max(0, stepCount)} step${stepCount === 1 ? '' : 's'}`;
  if (durationMs && durationMs > 0) {
    const sec = Math.max(1, Math.round(durationMs / 1000));
    return `Worked for ${sec}s · ${steps}`;
  }
  return steps;
}

export type GroupedAssistantBlocks = {
  processBlocks: AssistantMessageBlock[];
  visibleBlocks: AssistantMessageBlock[];
  /** True when a run timeline already contains tool activity. */
  hasActivity: boolean;
};

/**
 * One disclosure's process vs the default-view blocks.
 * Tool-result cards are never shown outside the disclosure, and are omitted
 * from the disclosure when an activity timeline already lists those tools.
 */
export function groupAssistantBlocks(
  blocks: AssistantMessageBlock[] | undefined | null,
): GroupedAssistantBlocks {
  const list = Array.isArray(blocks) ? blocks : [];
  const hasActivity = list.some(block => block.type === 'activity');
  const processBlocks: AssistantMessageBlock[] = [];
  const visibleBlocks: AssistantMessageBlock[] = [];
  for (const block of list) {
    if (block.type === 'activity' || block.type === 'progress') {
      processBlocks.push(block);
      continue;
    }
    if (block.type === 'tool-result') {
      if (!hasActivity) processBlocks.push(block);
      continue;
    }
    visibleBlocks.push(block);
  }
  return { processBlocks, visibleBlocks, hasActivity };
}

export function collapsedProcessLabel(run: AssistantRun | undefined, processBlocks: AssistantMessageBlock[]): string {
  const fromRun = run?.steps.length ?? 0;
  const fromBlocks = processBlocks.filter(
    block => block.type === 'progress' || block.type === 'tool-result',
  ).length;
  const stepCount = fromRun || fromBlocks || processBlocks.length;
  const started = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  const ended = run?.completedAt ? Date.parse(run.completedAt) : Date.now();
  const durationMs = Number.isFinite(started) ? Math.max(0, ended - started) : undefined;
  if (run?.status === 'running') return 'Working';
  return formatWorkedSummary(stepCount, durationMs);
}

export function textLooksLikeRawInternals(text: string): boolean {
  const sample = String(text || '');
  if (ROLE_CHIP_RE.test(sample)) return true;
  if (STEP_COUNTER_RE.test(sample)) return true;
  if (/\[\s*\{/.test(sample) || /"code"\s*:/.test(sample)) return true;
  return RAW_TOOL_ID_RE.test(sample);
}

export function collapsedViewContainsRawInternals(collapsedText: string): boolean {
  return textLooksLikeRawInternals(collapsedText);
}

export function activityDetailText(activity: ToolActivity): string {
  const chunks = [activity.toolId, activity.title];
  if (activity.input != null) chunks.push(JSON.stringify(activity.input));
  if (activity.output != null) chunks.push(JSON.stringify(activity.output));
  return chunks.filter(Boolean).join('\n');
}

export const PROCESS_BLOCK_TYPE_SET = PROCESS_BLOCK_TYPES;
export const PROCESS_TYPES_LIST = PROCESS_TYPES;
