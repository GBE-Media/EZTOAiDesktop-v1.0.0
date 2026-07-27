import type { TradeType } from '../providers/types';

export interface AgentContextInput {
  userIntent: string;
  trade: TradeType;
  currentPage?: number;
  documentName?: string | null;
  documentId?: string | null;
  totalPages?: number;
  projectPath?: string | null;
  screen?: string;
  role?: string | null;
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
  takeoffSummary?: string;
  materialCountsSummary?: string;
  catalogSummary?: string;
  markupsSummary?: string;
  permissions?: string[];
}

/**
 * Build a compact context blob for the agent system/user preamble.
 * Never dumps full DB / entire app state.
 */
export function buildAgentContext(input: AgentContextInput): {
  text: string;
  snapshot: Record<string, unknown>;
} {
  const recent = (input.recentTurns || [])
    .slice(-8)
    .map(turn => ({
      role: turn.role,
      content: turn.content.length > 800 ? `${turn.content.slice(0, 800)}…` : turn.content,
    }));

  const snapshot: Record<string, unknown> = {
    intent: input.userIntent.slice(0, 500),
    trade: input.trade,
    screen: input.screen || 'editor',
    document: input.documentId
      ? {
          id: input.documentId,
          name: input.documentName || null,
          page: input.currentPage || null,
          totalPages: input.totalPages || null,
        }
      : null,
    projectPath: input.projectPath || null,
    role: input.role || null,
    permissions: input.permissions || [],
    takeoffSummary: truncate(input.takeoffSummary, 2_500),
    materialCountsSummary: truncate(input.materialCountsSummary, 1_500),
    catalogSummary: truncate(input.catalogSummary, 2_000),
    markupsSummary: truncate(input.markupsSummary, 2_000),
    recentTurns: recent,
  };

  const lines = [
    '## Current app context (relevant slice only)',
    `- User intent: ${truncate(input.userIntent, 500)}`,
    `- Trade: ${input.trade}`,
    `- Screen: ${input.screen || 'editor'}`,
    input.documentName
      ? `- Document: ${input.documentName} (page ${input.currentPage || '?'}${input.totalPages ? ` / ${input.totalPages}` : ''})`
      : '- Document: none open',
    input.projectPath ? `- Project path: ${input.projectPath}` : null,
    input.role ? `- Role: ${input.role}` : null,
    input.markupsSummary ? `\n### Markups\n${truncate(input.markupsSummary, 2_000)}` : null,
    input.takeoffSummary ? `\n### Takeoff\n${truncate(input.takeoffSummary, 2_500)}` : null,
    input.materialCountsSummary ? `\n### Material counts\n${truncate(input.materialCountsSummary, 1_500)}` : null,
    input.catalogSummary ? `\n### Catalog (truncated)\n${truncate(input.catalogSummary, 2_000)}` : null,
    recent.length
      ? `\n### Recent conversation\n${recent.map(t => `${t.role}: ${t.content}`).join('\n')}`
      : null,
  ].filter(Boolean);

  return { text: lines.join('\n'), snapshot };
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
