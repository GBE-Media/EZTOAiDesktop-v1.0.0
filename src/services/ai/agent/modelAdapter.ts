import { getAIService } from '../aiService';
import type { AICompletionResponse } from '../providers/types';
import type { AgentModelDecision, AgentModelMessage, ModelUsedEntry } from './types';
import type { AgentModelRole } from './roles';
import { buildAgentSystemPrompt } from './prompts/system';
import { emitAgentTrace } from './trace';
import { parseAgentDecision } from './decisionParser';
import { registerAllAgentTools } from './tools/registerAll';
import {
  assistantToolsToProxyDefinitions,
  decisionFromCompletion,
} from '../tools/toProxyTools';

export { parseAgentDecision } from './decisionParser';
export { decisionFromCompletion } from '../tools/toProxyTools';

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
 * Role-aware model adapter for the primary agent (and fallback).
 * Passes the assistant tool registry as native provider tools; falls back to
 * JSON free-form parsing when the provider returns no toolCalls.
 */
export function createJsonToolModelAdapter(
  defaultRole: Extract<AgentModelRole, 'primary' | 'fallback'> = 'primary'
): ModelAdapter {
  return {
    async complete(options) {
      if (options.signal?.aborted) {
        throw new DOMException('Assistant run cancelled', 'AbortError');
      }

      registerAllAgentTools();
      const tools = assistantToolsToProxyDefinitions();

      const role = options.role || defaultRole;
      const system = `${buildAgentSystemPrompt()}\n\n${options.contextText}`;
      const history = options.messages
        .filter(message => message.role !== 'system')
        .map(message => {
          if (message.role === 'tool') {
            return {
              role: 'tool' as const,
              content: message.content,
              toolCallId: message.toolCallId,
              name: message.name,
            };
          }
          if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
            return {
              role: 'assistant' as const,
              content: message.content,
              toolCalls: message.toolCalls.map(call => ({
                id: call.id,
                name: call.name,
                input: call.arguments,
              })),
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

      // Native tools + text responses. Do not force json_object — that conflicts
      // with provider tool_use / tool_calls on several models. JSON plan/clarify/
      // final (and JSON tool_calls) still work via parseAgentDecision fallback.
      const shared = {
        temperature: 0.2,
        maxTokens: 4096,
        responseFormat: 'text' as const,
        tools,
        toolChoice: 'auto' as const,
      };

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
          ...shared,
        });
      } else {
        response = await ai.completeForRole(role, {
          messages: [
            { role: 'system', content: system },
            ...history,
          ],
          ...shared,
        });
      }

      const decision = decisionFromCompletion({
        content: response.content,
        toolCalls: response.toolCalls,
      });
      emitAgentTrace(options.runId, decision.type === 'plan' ? 'plan' : 'tool_selected', {
        decisionType: decision.type,
        role,
        nativeToolCalls: (response.toolCalls || []).length,
        preview: response.content.slice(0, 500),
      });
      return decision;
    },
  };
}
