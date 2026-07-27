import { getAIService } from '../aiService';
import type { AICompletionResponse } from '../providers/types';
import type { AgentModelDecision, AgentModelMessage, ModelUsedEntry } from './types';
import type { AgentModelRole } from './roles';
import { buildAgentSystemPrompt } from './prompts/system';
import { emitAgentTrace } from './trace';
import { parseAgentDecision } from './decisionParser';

export { parseAgentDecision } from './decisionParser';

export interface ModelAdapterCompleteOptions {
  runId: string;
  messages: AgentModelMessage[];
  contextText: string;
  signal?: AbortSignal;
  imageBase64?: string;
  /** Defaults to primary. Use fallback on invoke_fallback path. */
  role?: Extract<AgentModelRole, 'primary' | 'fallback'>;
  onModelUsed?: (entry: ModelUsedEntry) => void;
}

export interface ModelAdapter {
  complete(options: ModelAdapterCompleteOptions): Promise<AgentModelDecision>;
}

/**
 * Role-aware JSON tool adapter for the primary agent (and fallback).
 * Fixes the old broken complete('chat') stage call.
 */
export function createJsonToolModelAdapter(
  defaultRole: Extract<AgentModelRole, 'primary' | 'fallback'> = 'primary'
): ModelAdapter {
  return {
    async complete(options) {
      if (options.signal?.aborted) {
        throw new DOMException('Assistant run cancelled', 'AbortError');
      }

      const role = options.role || defaultRole;
      const system = `${buildAgentSystemPrompt()}\n\n${options.contextText}`;
      const history = options.messages
        .filter(message => message.role !== 'system')
        .map(message => {
          if (message.role === 'tool') {
            return {
              role: 'user' as const,
              content: `TOOL_RESULT name=${message.name || 'tool'} id=${message.toolCallId || ''}\n${message.content}`,
            };
          }
          return {
            role: message.role as 'user' | 'assistant' | 'system',
            content: message.content,
          };
        });

      const ai = getAIService();
      const selection = ai.getAgentRoleConfig(role);
      options.onModelUsed?.({
        role,
        provider: selection.provider,
        model: selection.model,
        phase: role === 'fallback' ? 'fallback' : 'primary',
      });

      let response: AICompletionResponse;

      if (options.imageBase64) {
        const lastUserIndex = [...history].map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0).pop();
        response = await ai.visionForRole(role, {
          messages: [
            { role: 'system', content: system },
            ...history.map((message, index) => ({
              role: message.role,
              content: message.content,
              images: index === lastUserIndex ? [options.imageBase64!] : undefined,
            })),
          ],
          temperature: 0.2,
          maxTokens: 4096,
          responseFormat: 'json',
        });
      } else {
        response = await ai.completeForRole(role, {
          messages: [
            { role: 'system', content: system },
            ...history,
          ],
          temperature: 0.2,
          maxTokens: 4096,
          responseFormat: 'json',
        });
      }

      const decision = parseAgentDecision(response.content);
      emitAgentTrace(options.runId, decision.type === 'plan' ? 'plan' : 'tool_selected', {
        decisionType: decision.type,
        role,
        preview: response.content.slice(0, 500),
      });
      return decision;
    },
  };
}
