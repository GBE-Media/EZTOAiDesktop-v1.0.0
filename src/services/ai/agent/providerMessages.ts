import type { AIMessage, AIToolCall } from '../providers/types';
import type { AgentModelMessage, AgentToolCallRequest } from '../agent/types';

/**
 * Convert agent session messages into provider AIMessage[] without dropping
 * native tool metadata. Also repairs common multi-round pairing breaks so
 * OpenAI/Lovable never see a role:'tool' without a preceding assistant
 * tool_calls entry that lists that tool_call_id.
 */
export function agentMessagesToProviderMessages(
  messages: AgentModelMessage[],
): AIMessage[] {
  const mapped: AIMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      mapped.push({
        role: 'tool',
        content: message.content ?? '',
        toolCallId: normalizeToolCallId(message.toolCallId, message.name),
        name: message.name,
      });
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls = normalizeToolCalls(message.toolCalls);
      if (toolCalls.length > 0) {
        mapped.push({
          role: 'assistant',
          content: message.content ?? '',
          toolCalls,
        });
        continue;
      }
      mapped.push({
        role: 'assistant',
        content: message.content ?? '',
      });
      continue;
    }

    mapped.push({
      role: 'user',
      content: message.content ?? '',
    });
  }

  return repairToolCallPairing(mapped);
}

/**
 * Ensure every tool message's toolCallId appears on the nearest preceding
 * assistant toolCalls group (walking back through consecutive tool messages).
 * If an assistant is missing toolCalls but is followed by tool results, synthesize
 * them from those results so multi-round / multi-tool history stays valid.
 */
export function repairToolCallPairing(messages: AIMessage[]): AIMessage[] {
  const out = messages.map(message => ({ ...message, toolCalls: message.toolCalls ? [...message.toolCalls] : undefined }));

  for (let i = 0; i < out.length; i += 1) {
    const message = out[i];
    if (message.role !== 'tool') continue;

    const toolCallId = normalizeToolCallId(message.toolCallId, message.name);
    message.toolCallId = toolCallId;

    const assistantIndex = findPrecedingAssistantIndex(out, i);
    if (assistantIndex < 0) {
      // Orphan tool with no assistant — synthesize a minimal assistant tool_calls.
      out.splice(i, 0, {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: toolCallId,
          name: message.name || 'tool',
          input: {},
        }],
      });
      i += 1;
      continue;
    }

    const assistant = out[assistantIndex];
    const existing = assistant.toolCalls || [];
    if (!existing.some(call => call.id === toolCallId)) {
      assistant.toolCalls = [
        ...existing,
        {
          id: toolCallId,
          name: message.name || 'tool',
          input: {},
        },
      ];
    }
  }

  return out;
}

/** True when every tool message is covered by a preceding assistant tool_calls id. */
export function assertOpenAIToolPairing(messages: AIMessage[]): {
  ok: boolean;
  problems: Array<{ index: number; toolCallId: string }>;
} {
  const problems: Array<{ index: number; toolCallId: string }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'tool') continue;
    const toolCallId = String(message.toolCallId || '');
    const assistantIndex = findPrecedingAssistantIndex(messages, i);
    if (assistantIndex < 0) {
      problems.push({ index: i, toolCallId });
      continue;
    }
    const calls = messages[assistantIndex].toolCalls || [];
    if (!calls.some(call => call.id === toolCallId)) {
      problems.push({ index: i, toolCallId });
    }
  }

  return { ok: problems.length === 0, problems };
}

function findPrecedingAssistantIndex(messages: AIMessage[], toolIndex: number): number {
  for (let j = toolIndex - 1; j >= 0; j -= 1) {
    const prev = messages[j];
    if (prev.role === 'tool') continue;
    if (prev.role === 'assistant') return j;
    return -1;
  }
  return -1;
}

function normalizeToolCalls(
  raw: AgentToolCallRequest[] | AIToolCall[] | undefined,
): AIToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((call, index) => {
    const record = call as AgentToolCallRequest & AIToolCall & { arguments?: unknown; input?: unknown };
    const id = normalizeToolCallId(record.id, record.name, index);
    const name = String(record.name || `tool_${index + 1}`);
    const input = record.input != null
      ? record.input
      : (record.arguments != null ? record.arguments : {});
    return { id, name, input };
  }).filter(call => call.name);
}

function normalizeToolCallId(
  id: string | undefined,
  name: string | undefined,
  index = 0,
): string {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (trimmed) return trimmed;
  const fromName = typeof name === 'string' && name.trim() ? name.trim() : 'tool';
  return `call_${fromName}_${index + 1}`;
}
