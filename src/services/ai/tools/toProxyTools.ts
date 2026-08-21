import type { AIToolCall, AIToolDefinition } from '../providers/types';
import type { AgentModelDecision, AgentToolCallRequest } from '../agent/types';
import { listAssistantTools } from './registry';
import { zodToJsonSchema } from './zodToJsonSchema';
import { parseAgentDecision } from '../agent/decisionParser';

/**
 * Convert the live assistant tool registry into proxy/provider tool definitions.
 * Uses each tool's Zod `schema` as JSON Schema `inputSchema` (per-tool mutation shapes).
 */
export function assistantToolsToProxyDefinitions(): AIToolDefinition[] {
  return listAssistantTools().map(tool => ({
    name: tool.id,
    description: [
      tool.description,
      tool.requiresConfirmation ? 'Requires user approval before applying changes.' : null,
      tool.isStub ? 'Stub — may not return real data yet.' : null,
    ].filter(Boolean).join(' '),
    inputSchema: zodToJsonSchema(tool.schema),
  }));
}

/**
 * Prefer native provider toolCalls when present; otherwise keep the JSON free-form
 * decision parser (plan / clarify / final / JSON tool_calls) as fallback.
 */
export function decisionFromCompletion(options: {
  content: string;
  toolCalls?: AIToolCall[] | null;
}): AgentModelDecision {
  const native = options.toolCalls || [];
  if (native.length > 0) {
    const toolCalls: AgentToolCallRequest[] = native.slice(0, 3).map((call, index) => {
      const input = call.input;
      const args = (typeof input === 'object' && input && !Array.isArray(input)
        ? input
        : typeof input === 'string'
          ? safeParseObject(input)
          : {}) as Record<string, unknown>;
      return {
        id: String(call.id || `call_${index + 1}`),
        name: String(call.name || ''),
        arguments: args,
      };
    }).filter(call => call.name);

    if (toolCalls.length > 0) {
      const assistantText = typeof options.content === 'string' && options.content.trim()
        ? options.content.trim()
        : undefined;
      return {
        type: 'tool_calls',
        toolCalls,
        assistantText,
      };
    }
  }

  return parseAgentDecision(options.content || '');
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}
