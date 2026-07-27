import { getAIService } from '../../aiService';
import { buildRouterSystemPrompt } from '../prompts/router';
import type { IntakeResult } from '../phases/intake';
import { decideRoutingPolicy, mergeRouterModelDecision } from './policy';
import type { ModelUsedEntry, RoutingDecision } from '../types';

export interface RunRoutingOptions {
  runId: string;
  intake: IntakeResult;
  signal?: AbortSignal;
}

export interface RoutingPhaseResult {
  decision: RoutingDecision;
  modelsUsed: ModelUsedEntry[];
  usedLlmRouter: boolean;
}

/** Phase 2: deterministic policy first; lightweight router model only when needed. */
export async function runRouting(options: RunRoutingOptions): Promise<RoutingPhaseResult> {
  const policy = decideRoutingPolicy(options.intake);
  const modelsUsed: ModelUsedEntry[] = [];

  if (!policy.needsLlmRouter) {
    const { needsLlmRouter: _, ...decision } = policy;
    return { decision, modelsUsed, usedLlmRouter: false };
  }

  if (options.signal?.aborted) {
    throw new DOMException('Assistant run cancelled', 'AbortError');
  }

  const ai = getAIService();
  const role = ai.getAgentRoleConfig('router');
  modelsUsed.push({
    role: 'router',
    provider: role.provider,
    model: role.model,
    phase: 'routing',
  });

  try {
    const response = await ai.completeForRole('router', {
      messages: [
        { role: 'system', content: buildRouterSystemPrompt() },
        {
          role: 'user',
          content: JSON.stringify({
            message: options.intake.normalizedMessage,
            preliminaryTaskType: options.intake.preliminaryTaskType,
            preliminaryRisk: options.intake.preliminaryRisk,
            hasImage: options.intake.hasImage,
            contextPreview: options.intake.contextText.slice(0, 1500),
          }),
        },
      ],
      temperature: 0,
      maxTokens: 600,
      responseFormat: 'json',
    });

    const parsed = parseRouterJson(response.content);
    const { needsLlmRouter: _, ...policyDecision } = policy;
    return {
      decision: mergeRouterModelDecision(policyDecision, parsed),
      modelsUsed,
      usedLlmRouter: true,
    };
  } catch {
    const { needsLlmRouter: _, ...decision } = policy;
    return { decision, modelsUsed, usedLlmRouter: false };
  }
}

function parseRouterJson(raw: string): Partial<RoutingDecision> {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned) as Partial<RoutingDecision>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
