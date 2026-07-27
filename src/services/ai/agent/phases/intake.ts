import type { TradeType } from '../providers/types';
import { buildAgentContext, type AgentContextInput } from '../contextBuilder';
import type { RiskLevel, TaskType } from '../types';

export interface IntakeInput extends AgentContextInput {
  userMessage: string;
  hasImage?: boolean;
}

export interface IntakeResult {
  normalizedMessage: string;
  contextText: string;
  contextSnapshot: Record<string, unknown>;
  preliminaryTaskType: TaskType;
  preliminaryRisk: RiskLevel;
  trade: TradeType;
  hasImage: boolean;
}

/** Phase 1: normalize message + slim context + cheap preliminary classify (no LLM). */
export function runIntake(input: IntakeInput): IntakeResult {
  const normalizedMessage = input.userMessage.replace(/\s+/g, ' ').trim();
  const { text, snapshot } = buildAgentContext({
    ...input,
    userIntent: normalizedMessage,
  });
  const lower = normalizedMessage.toLowerCase();

  let preliminaryTaskType: TaskType = 'other';
  let preliminaryRisk: RiskLevel = 'low';

  if (!normalizedMessage || /\b(which|what|where|how|clarify|missing)\b/.test(lower) && /\?$/.test(normalizedMessage) === false && normalizedMessage.length < 12) {
    preliminaryTaskType = 'ambiguous';
    preliminaryRisk = 'medium';
  }
  if (/\b(code|nec|compliance|ahj|inspect)\b/.test(lower)) {
    preliminaryTaskType = 'compliance';
    preliminaryRisk = 'high';
  } else if (/\b(price|cost|bid|margin|dollar|\$|pricing)\b/.test(lower)) {
    preliminaryTaskType = 'cost_sensitive';
    preliminaryRisk = 'high';
  } else if (/\b(place|save|update|delete|adjust|apply|write|edit)\b/.test(lower)) {
    preliminaryTaskType = 'write_action';
    preliminaryRisk = 'medium';
  } else if (/\b(layout|run|homerun|conduit|route)\b/.test(lower)) {
    preliminaryTaskType = 'layout';
    preliminaryRisk = 'medium';
  } else if (/\b(count|material|takeoff|markup|page|document|project|summary)\b/.test(lower)) {
    preliminaryTaskType = 'read_context';
    preliminaryRisk = 'low';
  } else if (normalizedMessage.length < 80 && !/\b(estimate|takeoff|compliance)\b/.test(lower)) {
    preliminaryTaskType = 'simple_qa';
    preliminaryRisk = 'low';
  }

  return {
    normalizedMessage,
    contextText: text,
    contextSnapshot: snapshot,
    preliminaryTaskType,
    preliminaryRisk,
    trade: input.trade,
    hasImage: Boolean(input.hasImage),
  };
}
