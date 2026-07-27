import { getAIService } from '../aiService';
import type { AICompletionResponse } from '../providers/types';
import type { AgentModelDecision, AgentModelMessage } from './types';
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
}

export interface ModelAdapter {
  complete(options: ModelAdapterCompleteOptions): Promise<AgentModelDecision>;
}

/**
 * Provider-agnostic adapter: asks the model for a JSON decision object.
 * Native function-calling can replace parseDecision later without changing the runner.
 */
export function createJsonToolModelAdapter(): ModelAdapter {
  return {
    async complete(options) {
      if (options.signal?.aborted) {
        throw new DOMException('Assistant run cancelled', 'AbortError');
      }

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
      let response: AICompletionResponse;

      if (options.imageBase64) {
        const lastUserIndex = [...history].map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0).pop();
        response = await ai.vision({
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
        response = await ai.complete('chat', {
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
        preview: response.content.slice(0, 500),
      });
      return decision;
    },
  };
}
