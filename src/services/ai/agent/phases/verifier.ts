import { getAIService } from '../../aiService';
import { buildVerifierSystemPrompt } from '../prompts/verifier';
import { emitAgentTrace } from '../trace';
import { runVerificationTools } from '../verification';
import type { AssistantToolContext } from '../../tools/types';
import type { ModelUsedEntry, VerificationSummary } from '../types';

export interface VerifierInput {
  runId: string;
  draftMessage: string;
  actionsTaken: Array<{ toolId: string; summary: string; status: string }>;
  toolHistorySummaries: string[];
  requireLlm: boolean;
  lastWriteToolId?: string;
  toolContext: AssistantToolContext;
  signal?: AbortSignal;
}

export interface VerifierPhaseResult {
  summary: VerificationSummary;
  modelsUsed: ModelUsedEntry[];
  finalMessage: string;
  blockedClarification?: string;
}

/** Phase 4: deterministic checks first; optional LLM verifier for high-impact review. */
export async function runVerificationPhase(input: VerifierInput): Promise<VerifierPhaseResult> {
  const modelsUsed: ModelUsedEntry[] = [];
  const deterministic: VerificationSummary['deterministic'] = [];

  if (input.lastWriteToolId) {
    const results = await runVerificationTools(input.lastWriteToolId, input.toolContext);
    for (const result of results) {
      emitAgentTrace(input.runId, 'deterministic_check', {
        summary: result.summary,
        status: result.status,
      });
      deterministic.push({
        toolId: input.lastWriteToolId,
        summary: result.summary,
        status: result.status,
      });
    }
  }

  let llm: VerificationSummary['llm'] | undefined;
  let finalMessage = input.draftMessage;
  let blockedClarification: string | undefined;

  if (input.requireLlm) {
    if (input.signal?.aborted) {
      throw new DOMException('Assistant run cancelled', 'AbortError');
    }
    const ai = getAIService();
    const role = ai.getAgentRoleConfig('verifier');
    modelsUsed.push({
      role: 'verifier',
      provider: role.provider,
      model: role.model,
      phase: 'verification',
    });

    try {
      const response = await ai.completeForRole('verifier', {
        messages: [
          { role: 'system', content: buildVerifierSystemPrompt() },
          {
            role: 'user',
            content: JSON.stringify({
              draftMessage: input.draftMessage,
              actionsTaken: input.actionsTaken,
              toolHistory: input.toolHistorySummaries,
              deterministicChecks: deterministic,
            }),
          },
        ],
        temperature: 0,
        maxTokens: 1200,
        responseFormat: 'json',
      });

      const parsed = parseVerifierJson(response.content);
      llm = {
        verdict: parsed.verdict || 'approve',
        issues: parsed.issues || [],
        summary: parsed.summary || 'Verifier completed',
      };
      emitAgentTrace(input.runId, 'verifier_outcome', llm);

      if (parsed.verdict === 'revise' && parsed.revisedMessage) {
        finalMessage = parsed.revisedMessage;
      } else if (parsed.verdict === 'ask_clarification' && parsed.clarificationQuestion) {
        blockedClarification = parsed.clarificationQuestion;
        finalMessage = parsed.clarificationQuestion;
      } else if (parsed.verdict === 'escalate') {
        finalMessage = `${input.draftMessage}\n\nWarning: ${parsed.summary || 'This result needs human review before relying on it.'}`;
      }
    } catch (error) {
      emitAgentTrace(input.runId, 'verifier_outcome', {
        verdict: 'approve',
        summary: 'Verifier unavailable; continuing with draft',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    summary: { deterministic, llm },
    modelsUsed,
    finalMessage,
    blockedClarification,
  };
}

function parseVerifierJson(raw: string): {
  verdict?: VerificationSummary['llm'] extends infer T ? T extends { verdict: infer V } ? V : never : never;
  issues?: string[];
  summary?: string;
  revisedMessage?: string;
  clarificationQuestion?: string;
} {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(cleaned);
  } catch {
    return { verdict: 'approve', issues: [], summary: 'Could not parse verifier output; treating as approve' };
  }
}
